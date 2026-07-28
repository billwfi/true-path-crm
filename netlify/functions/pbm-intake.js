const { mssql, sql } = require('./_mssql');
const { ok, created, badRequest, serverError, options } = require('./_auth');

// Inbound member-record intake API for a PBM feed (e.g. Liviniti).
// AUTH: static key in the `x-api-key` header, compared to env PBM_INTAKE_KEY.
//   (No user JWT — this is called by an external system.)
// POST /.netlify/functions/pbm-intake        body: one record  OR  { members: [ ... ] }  OR  [ ... ]
//   ?pbm_id=N  (optional; defaults to the PBM with pbm_code='LIVINITI')
// Records use the RxCompass eligibility field names (see COLS). Unknown keys are
// still preserved in RawJson. Rows land in dbo.PBM_Member_Intake (accumulates).

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

    // resolve target PBM
    const q = event.queryStringParameters || {};
    let pbmId = parseInt(q.pbm_id || body.pbm_id, 10) || null;
    if (!pbmId) {
      const r = await mssql("SELECT id FROM dbo.tp_pbms WHERE pbm_code='LIVINITI'");
      pbmId = r.recordset[0] ? r.recordset[0].id : null;
    }

    let accepted = 0;
    const rejected = [];
    for (let i = 0; i < records.length; i++) {
      const mapped = normalize(records[i]);
      if (!mapped.GroupID) { rejected.push({ index: i, reason: 'GroupID required' }); continue; }
      if (!mapped.LastName && !mapped.CardholderID && !mapped.MemberSSN) {
        rejected.push({ index: i, reason: 'need LastName or CardholderID or MemberSSN' }); continue;
      }
      const cols = Object.keys(mapped);
      const colList = ['pbm_id', ...cols, 'Source', 'RawJson'].map(c => `[${c}]`).join(', ');
      const valList = ['@pbm_id', ...cols.map(c => `@${c}`), "'api'", '@RawJson'].join(', ');
      const params = { pbm_id: pbmId, RawJson: JSON.stringify(records[i]).slice(0, 1000000) };
      cols.forEach(c => { params[c] = mapped[c]; });
      await mssql(`INSERT INTO dbo.PBM_Member_Intake (${colList}) VALUES (${valList})`, params);
      accepted++;
    }

    return created({ accepted, rejected, pbm_id: pbmId, received: records.length });
  } catch (err) {
    return serverError(err);
  }
};
