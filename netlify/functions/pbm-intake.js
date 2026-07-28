const { mssql, sql } = require('./_mssql');
const { ok, created, badRequest, serverError, options } = require('./_auth');
const { sendEmail } = require('./_email');

// Inbound member-record intake API for a PBM feed (e.g. Liviniti).
// AUTH: static key in the `x-api-key` header, compared to env PBM_INTAKE_KEY.
//   (No user JWT — this is called by an external system.)
// POST /api/pbm-intake        body: one record  OR  { members: [ ... ] }  OR  [ ... ]
// Each record identifies its group by our internal TP Group ID, sent as
//   "TPGroupID": "TP1001"   (or carried in "GroupID": "TP1001").
// The API resolves it to the PBM group, stamps the real eligibility GroupID/GroupName
// and pbm_id, and records TPGroupID. A raw eligibility GroupID is still accepted as a
// fallback. Other fields use the RxCompass eligibility names (see COLS); unknown keys
// are preserved in RawJson. Rows land in dbo.PBM_Member_Intake (accumulates).

const COLS = [
  'CardholderID','PersonCode','Relationship','LastName','FirstName','MiddleName','Suffix','Gender',
  'DateOfBirth','CardholderSSN','MemberSSN','ExternalID','Address1','Address2','City','State','Zip',
  'HomePhone','EmailAddress','GroupID','ARType','EffectiveStart','EffectiveEnd','PlanName',
  'EmployeeStatusCode','EmployeeStatus','EmployeeStatusDetail','SecondaryCoverageOnly','Active','ClientID',
  'GroupName','NewTechID','EmployeeStatusEffectiveStart','EmployeeLocationCode','EmployeeLocation',
  'EmployeeLocationDetail','EmployeeLocationEffectiveStart','CoverageLevelCode','AlternateID',
  'OtherStatusCode','OtherStatus','OtherStatusDetail','OtherStatusEffectiveStart','CreatedOn','ChangedOn',
];
const COL_LC = new Map(COLS.map(c => [c.toLowerCase(), c]));

function normalize(rec) {
  // case-insensitive map of posted keys -> canonical column names
  const out = {};
  for (const [k, v] of Object.entries(rec || {})) {
    const col = COL_LC.get(String(k).toLowerCase());
    if (col && v != null && v !== '') out[col] = String(v).slice(0, 4000);
  }
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const key = (event.headers['x-api-key'] || event.headers['X-Api-Key'] || '').trim();
  if (!process.env.PBM_INTAKE_KEY || key !== process.env.PBM_INTAKE_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'invalid or missing x-api-key' }) };
  }

  try {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return badRequest('invalid JSON'); }
    const records = Array.isArray(body) ? body : (Array.isArray(body.members) ? body.members : [body]);
    if (!records.length) return badRequest('no records');
    if (records.length > 5000) return badRequest('max 5000 records per request');

    // A record identifies its group by our internal TP Group ID (preferred),
    // supplied as `TPGroupID` (or carried in `GroupID` as e.g. "TP1001").
    const tpRefOf = (rec) => {
      let raw = null;
      for (const [k, v] of Object.entries(rec || {})) {
        const lk = String(k).toLowerCase();
        if ((lk === 'tpgroupid' || lk === 'tp_group_id') && v != null && v !== '') { raw = String(v).trim(); break; }
      }
      if (!raw) { const g = normalize(rec).GroupID; if (g && /^TP\d+$/i.test(g)) raw = g; }
      return raw;
    };

    // Pre-load referenced TP groups in one query.
    const refs = [...new Set(records.map(tpRefOf).filter(Boolean).map(r => r.toUpperCase()))];
    const tpMap = {};
    if (refs.length) {
      const inList = refs.map((_, i) => `@t${i}`).join(',');
      const params = {}; refs.forEach((v, i) => params['t' + i] = v);
      (await mssql(`SELECT tp_group_id, pbm_id, group_code, group_name FROM dbo.PBM_Groups
                    WHERE UPPER(tp_group_id) IN (${inList})`, params)).recordset
        .forEach(g => { tpMap[g.tp_group_id.toUpperCase()] = g; });
    }

    const q = event.queryStringParameters || {};
    let defaultPbm = parseInt(q.pbm_id || body.pbm_id, 10) || null;
    if (!defaultPbm) {
      const r = await mssql("SELECT id FROM dbo.tp_pbms WHERE pbm_code='LIVINITI'");
      defaultPbm = r.recordset[0] ? r.recordset[0].id : null;
    }

    let accepted = 0;
    const rejected = [];
    for (let i = 0; i < records.length; i++) {
      const mapped = normalize(records[i]);
      let pbmId = defaultPbm, tpGroupId = null;
      const tpRef = tpRefOf(records[i]);
      if (tpRef) {
        const g = tpMap[tpRef.toUpperCase()];
        if (!g) { rejected.push({ index: i, reason: `unknown TP Group ID '${tpRef}'` }); continue; }
        mapped.GroupID = g.group_code;                       // stamp the real eligibility GroupID
        if (!mapped.GroupName && g.group_name) mapped.GroupName = g.group_name;
        pbmId = g.pbm_id || defaultPbm;
        tpGroupId = g.tp_group_id;
      } else if (!mapped.GroupID) {
        rejected.push({ index: i, reason: 'TPGroupID (or GroupID) required' }); continue;
      }
      if (!mapped.LastName && !mapped.CardholderID && !mapped.MemberSSN) {
        rejected.push({ index: i, reason: 'need LastName or CardholderID or MemberSSN' }); continue;
      }
      const cols = Object.keys(mapped);
      const colList = ['pbm_id', ...cols, 'TPGroupID', 'Source', 'RawJson'].map(c => `[${c}]`).join(', ');
      const valList = ['@pbm_id', ...cols.map(c => `@${c}`), '@TPGroupID', "'api'", '@RawJson'].join(', ');
      const params = { pbm_id: pbmId, TPGroupID: tpGroupId, RawJson: JSON.stringify(records[i]).slice(0, 1000000) };
      cols.forEach(c => { params[c] = mapped[c]; });
      await mssql(`INSERT INTO dbo.PBM_Member_Intake (${colList}) VALUES (${valList})`, params);
      accepted++;
    }

    // Notify that new records were submitted (non-fatal).
    if (accepted > 0) {
      try {
        const to = process.env.INTAKE_NOTIFY_TO || 'bill@workflowinnovators.com';
        const rows = records.slice(0, 10).map((r) => {
          const m = normalize(r);
          return `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee;">${(m.LastName || '') + ', ' + (m.FirstName || '')}</td>
            <td style="padding:4px 10px;border-bottom:1px solid #eee;">${tpRefOf(r) || m.GroupID || ''}</td></tr>`;
        }).join('');
        const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f5;padding:24px 0;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">
          <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr><td style="background:#223f72;padding:18px 28px;" align="center"><img src="https://app.truepathsourcing.com/assets/img/truepath-logo-white.png" width="180" style="display:block;max-width:180px;height:auto;"></td></tr>
          <tr><td style="padding:24px 28px;color:#1e293b;font-size:15px;line-height:1.6;">
            <p style="margin:0 0 10px;font-size:18px;font-weight:700;color:#0a5e57;">New PBM member records submitted</p>
            <p style="margin:0 0 14px;"><b>${accepted}</b> record(s) received via the intake API${rejected.length ? ` (${rejected.length} rejected)` : ''}. Review and assign a Client Concierge in <b>PBM Tracking → Member Submissions</b>.</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;border-collapse:collapse;">
              <tr><th style="text-align:left;padding:4px 10px;border-bottom:2px solid #223f72;">Member</th><th style="text-align:left;padding:4px 10px;border-bottom:2px solid #223f72;">Group</th></tr>
              ${rows}
            </table>
            <p style="margin:14px 0 0;"><a href="https://app.truepathsourcing.com/pbms/intake/" style="color:#0a5e57;font-weight:600;">Open Member Submissions →</a></p>
          </td></tr></table></td></tr></table>`;
        await sendEmail({ to, subject: `PBM intake: ${accepted} new member record(s) submitted`, html });
      } catch (e) { /* notification is best-effort */ }
    }

    return created({ accepted, rejected, received: records.length });
  } catch (err) {
    return serverError(err);
  }
};
