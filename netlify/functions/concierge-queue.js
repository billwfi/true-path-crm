const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

// Client Concierge work queue (IA4) — a concierge's assigned intakes across all
// intake types (GLP1 + non-GLP1), with intake status, outreach attempt count, last
// contact, next follow-up, and Review & Close routing. Read-only.
//
//   GET /concierge-queue                       -> { rows, summary } for the logged-in CC
//   GET /concierge-queue?assigned_to=<id|all>  -> managers/admins can view any CC (or all)
//   GET /concierge-queue?resource=assignees    -> [{id,name,n}] concierges + their open counts
//   Filters (list): category, intake_status, group, search

const CAN_SEE_ALL = ['Admin', 'Call Center Manager'];
const MEMBER_KEY = `COALESCE(NULLIF(Member_ID, ''), CAST(indx AS VARCHAR(50)))`;

// Base assigned-intake set for a given assignee (or all). Deduped to one row per
// (category, member), keeping the latest claim, then enriched with intake status,
// type label/colour, contact-log aggregates and any Review & Close routing.
function baseCte(scopeAll) {
  const scope = scopeAll ? '' : 'AND r.assigned_to = @uid';
  return `
  WITH asn AS (
    SELECT r.indx, r.category, r.Group_Name, r.Member_ID, r.First_Name, r.Last_Name,
           r.City, r.State, r.Drug_Name, r.assigned_to, r.assigned_at,
           ${MEMBER_KEY} AS member_key,
           ROW_NUMBER() OVER (PARTITION BY r.category, ${MEMBER_KEY}
             ORDER BY r.Date_of_Service DESC, r.indx DESC) AS rn
    FROM dbo.ReadyToAssign r
    WHERE r.status = 'Assigned' ${scope}
  ),
  cl AS (
    SELECT member_key, category,
           COUNT(*) AS attempts,
           MAX(contact_date) AS last_contact,
           MIN(CASE WHEN contact_status = 'Open' AND followup_date IS NOT NULL THEN followup_date END) AS next_followup
    FROM dbo.GLP1_ContactLog
    GROUP BY member_key, category
  )`;
}

const SELECT_ROWS = `
  SELECT a.indx, a.category, a.Group_Name, a.Member_ID, a.First_Name, a.Last_Name,
         a.City, a.State, a.Drug_Name, a.assigned_at, a.assigned_to, a.member_key,
         mi.status AS intake_status, mi.sub_status AS intake_sub_status, mi.status_date, mi.priority,
         t.name AS type_name, t.color AS type_color,
         ISNULL(cl.attempts, 0) AS attempts, cl.last_contact, cl.next_followup,
         LTRIM(RTRIM(CONCAT(u.firstname, ' ', u.lastname))) AS assigned_name,
         rc.status AS review_close_status, rc.reason AS review_close_reason
  FROM asn a
  LEFT JOIN dbo.tp_member_intakes mi ON mi.member_key = a.member_key AND mi.intake_type = a.category
  LEFT JOIN dbo.tp_intake_types t   ON t.code = a.category
  LEFT JOIN cl ON cl.member_key = a.member_key AND cl.category = a.category
  LEFT JOIN dbo.Users u ON u.id = a.assigned_to
  LEFT JOIN dbo.tp_review_close rc ON rc.member_key = a.member_key AND rc.intake_type = a.category`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const q = event.queryStringParameters || {};
  const canSeeAll = CAN_SEE_ALL.includes(user.role);

  try {
    if (q.resource === 'assignees') {
      // For the manager/admin assignee switcher: every active concierge with their open count.
      const rows = (await mssql(`
        SELECT u.id, LTRIM(RTRIM(CONCAT(u.firstname, ' ', u.lastname))) AS name, u.email,
               (SELECT COUNT(*) FROM (
                  SELECT DISTINCT r.category, ${MEMBER_KEY} AS mk
                  FROM dbo.ReadyToAssign r
                  WHERE r.status = 'Assigned' AND r.assigned_to = u.id) x) AS n
        FROM dbo.Users u
        WHERE u.active = 1 AND (u.role = 'Client Concierge' OR u.role = 'Call Center Manager')
        ORDER BY name`)).recordset;
      return ok(rows);
    }

    // Resolve the assignee scope. Concierges only ever see their own queue.
    let scopeAll = false;
    const params = { uid: user.id };
    if (canSeeAll && q.assigned_to === 'all') scopeAll = true;
    else if (canSeeAll && q.assigned_to) params.uid = parseInt(q.assigned_to, 10) || user.id;

    const cte = baseCte(scopeAll);

    // Summary tiles over the assignee's full assigned set (unaffected by list filters).
    const summaryRow = (await mssql(`${cte}
      SELECT COUNT(*) AS open_intakes,
             SUM(CASE WHEN cl.next_followup < CAST(GETDATE() AS date) THEN 1 ELSE 0 END) AS overdue,
             SUM(CASE WHEN cl.next_followup = CAST(GETDATE() AS date) THEN 1 ELSE 0 END) AS due_today,
             SUM(CASE WHEN ISNULL(cl.attempts, 0) = 0 THEN 1 ELSE 0 END) AS unworked,
             SUM(CASE WHEN rc.status = 'Open' THEN 1 ELSE 0 END) AS review_close
      FROM asn a
      LEFT JOIN cl ON cl.member_key = a.member_key AND cl.category = a.category
      LEFT JOIN dbo.tp_review_close rc ON rc.member_key = a.member_key AND rc.intake_type = a.category
      WHERE a.rn = 1`, params)).recordset[0] || {};

    // Filtered list.
    const conds = ['a.rn = 1'];
    if (q.category)      { conds.push('a.category = @category'); params.category = q.category; }
    if (q.intake_status) { conds.push('mi.status = @intake_status'); params.intake_status = q.intake_status; }
    if (q.priority)      { conds.push('mi.priority = @priority'); params.priority = q.priority; }
    if (q.group)         { conds.push('a.Group_Name = @group'); params.group = q.group; }
    if (q.search) {
      conds.push(`(a.First_Name LIKE @search OR a.Last_Name LIKE @search OR a.Member_ID LIKE @search OR a.Drug_Name LIKE @search)`);
      params.search = `%${q.search}%`;
    }
    const rows = (await mssql(`${cte}
      ${SELECT_ROWS}
      WHERE ${conds.join(' AND ')}
      ORDER BY CASE WHEN cl.next_followup IS NULL THEN 1 ELSE 0 END, cl.next_followup ASC,
               a.Last_Name, a.First_Name`, params)).recordset;

    return ok({
      rows,
      scope: scopeAll ? 'all' : params.uid,
      canSeeAll,
      summary: {
        open_intakes: Number(summaryRow.open_intakes || 0),
        overdue:      Number(summaryRow.overdue || 0),
        due_today:    Number(summaryRow.due_today || 0),
        unworked:     Number(summaryRow.unworked || 0),
        review_close: Number(summaryRow.review_close || 0),
      },
    });
  } catch (err) {
    return serverError(err);
  }
};
