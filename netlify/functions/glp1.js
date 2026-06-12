const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, notFound, serverError, options } = require('./_auth');

// Roles permitted to assign / reassign GLP1 records.
const CAN_ASSIGN = ['Call Center Manager', 'Admin'];

const LIST_COLS = `indx, category, Group_Code, Group_Name, Member_ID, Claim_Patient_ID,
  Last_Name, First_Name, Date_of_Birth, Gender, City, State, Zip_Code,
  Date_of_Service, NDC, Drug_Name, Fill_Number, Quantity_Dispensed, Days_Supply,
  Pharmacy_Name, status, assigned_to, assigned_by, assigned_at, created_at`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { indx, status, group, search, category, stats, action, latest_per_member, drug, drugs, report } = event.queryStringParameters || {};
  const cat = category || 'GLP1';
  // When set, collapse to one row per Member_ID, keeping the most recent Date_of_Service.
  const onePerMember = latest_per_member === '1' || latest_per_member === 'true';
  // Members with no Member_ID stay distinct (keyed by indx) instead of collapsing together.
  const MEMBER_KEY = `COALESCE(NULLIF(Member_ID, ''), CAST(indx AS VARCHAR(50)))`;
  // Base drug name = leading token of Drug_Name (e.g. "OZEMPIC   INJ 8MG/3ML" -> "OZEMPIC").
  const DRUG_BASE = `RTRIM(LEFT(LTRIM(Drug_Name), CHARINDEX(' ', LTRIM(Drug_Name) + ' ') - 1))`;

  try {
    if (event.httpMethod === 'GET') {
      if (indx) {
        const r = await mssql(
          `SELECT ${LIST_COLS} FROM dbo.ReadyToAssign WHERE indx = @indx AND category = @category`,
          { indx: parseInt(indx, 10), category: cat });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      if (stats) {
        // Count distinct members (matching the deduped list) when requested, else raw rows.
        const countExpr = onePerMember ? `COUNT(DISTINCT ${MEMBER_KEY})` : 'COUNT(*)';
        const r = await mssql(
          `SELECT Group_Name, status, ${countExpr} AS n
           FROM dbo.ReadyToAssign WHERE category = @category
           GROUP BY Group_Name, status ORDER BY Group_Name`,
          { category: cat });
        return ok(r.recordset);
      }

      if (drugs) {
        // Distinct base drug names for the filter dropdown (optionally scoped to a status).
        const r = await mssql(
          `SELECT DISTINCT ${DRUG_BASE} AS drug FROM dbo.ReadyToAssign
           WHERE category = @category AND (@status IS NULL OR status = @status)
             AND LTRIM(RTRIM(ISNULL(Drug_Name, ''))) <> ''
           ORDER BY drug`,
          { category: cat, status: status || null });
        return ok(r.recordset.map(x => x.drug).filter(Boolean));
      }

      if (report === 'ready-by-month') {
        // Ready-to-assign members (deduped to latest claim) counted by Group_Name and
        // the year/month of that latest Date_of_Service.
        const r = await mssql(
          `WITH ranked AS (
             SELECT Group_Name, Date_of_Service,
               ROW_NUMBER() OVER (PARTITION BY ${MEMBER_KEY}
                 ORDER BY Date_of_Service DESC, indx DESC) AS rn
             FROM dbo.ReadyToAssign WHERE category = @category AND status = 'Ready to Assign')
           SELECT YEAR(Date_of_Service) AS yr, MONTH(Date_of_Service) AS mo,
                  Group_Name, COUNT(*) AS n
           FROM ranked WHERE rn = 1
           GROUP BY YEAR(Date_of_Service), MONTH(Date_of_Service), Group_Name
           ORDER BY yr, mo, Group_Name`,
          { category: cat });
        return ok(r.recordset);
      }

      const where = `category = @category
           AND (@status IS NULL OR status = @status)
           AND (@group IS NULL OR Group_Name = @group)
           AND (@drug IS NULL OR ${DRUG_BASE} = @drug)
           AND (@search IS NULL OR First_Name LIKE @search OR Last_Name LIKE @search
                OR Member_ID LIKE @search OR Drug_Name LIKE @search)`;
      const listSql = onePerMember
        ? `WITH ranked AS (
             SELECT ${LIST_COLS},
               ROW_NUMBER() OVER (PARTITION BY ${MEMBER_KEY}
                 ORDER BY Date_of_Service DESC, indx DESC) AS rn
             FROM dbo.ReadyToAssign WHERE ${where})
           SELECT ${LIST_COLS} FROM ranked WHERE rn = 1
           ORDER BY Group_Name, Last_Name, First_Name`
        : `SELECT ${LIST_COLS} FROM dbo.ReadyToAssign WHERE ${where}
           ORDER BY Group_Name, Last_Name, First_Name`;
      const r = await mssql(listSql,
        { category: cat, status: status || null, group: group || null,
          drug: drug || null, search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'PATCH') {
      if (!CAN_ASSIGN.includes(user.role)) {
        return { statusCode: 403, headers: require('./_auth').CORS,
          body: JSON.stringify({ error: 'Only Call Center Managers can assign GLP1 records' }) };
      }
      const b = JSON.parse(event.body || '{}');

      // Assignment is member-level: each selected indx affects ALL of that member's
      // records (matched via MEMBER_KEY), so a member fully leaves / returns to the
      // Ready to Assign list and the count bubbles update. The list is deduped to one
      // row per member, so the chosen indx is just a handle to the patient.
      const memberMatch = `category=@category
             AND ${MEMBER_KEY} = (SELECT ${MEMBER_KEY} FROM dbo.ReadyToAssign WHERE indx=@indx)`;

      if (action === 'unassign') {
        const ids = idList(b, indx);
        if (!ids.length) return badRequest('indx (or body.indxs) required');
        let affected = 0;
        for (const id of ids) {
          const r = await mssql(
            `UPDATE dbo.ReadyToAssign
             SET status='Ready to Assign', assigned_to=NULL, assigned_by=NULL, assigned_at=NULL
             WHERE ${memberMatch}`,
            { indx: id, category: cat });
          affected += r.rowsAffected[0] || 0;
        }
        return ok({ unassigned: ids.length, records: affected });
      }

      // Default action = assign
      const assignedTo = parseInt(b.assigned_to, 10);
      if (!assignedTo) return badRequest('assigned_to (Client Concierge staff id) required');
      const ids = idList(b, indx);
      if (!ids.length) return badRequest('indx (or body.indxs) required');

      let affected = 0;
      for (const id of ids) {
        const r = await mssql(
          `UPDATE dbo.ReadyToAssign
           SET status='Assigned', assigned_to=@assigned_to, assigned_by=@assigned_by, assigned_at=GETDATE()
           WHERE ${memberMatch}`,
          { indx: id, assigned_to: assignedTo, assigned_by: user.id || null, category: cat });
        affected += r.rowsAffected[0] || 0;

        // Auto-create the intake record (In Progress, dated today) the first time a member
        // is assigned. Existing intake records are left untouched on re-assignment.
        await mssql(
          `INSERT INTO dbo.GLP1_Intake (member_key, category, status, status_date, updated_by)
           SELECT m.k, @category, 'In Progress', CAST(GETDATE() AS DATE), @by
           FROM (SELECT ${MEMBER_KEY} AS k FROM dbo.ReadyToAssign WHERE indx=@indx) m
           WHERE NOT EXISTS (SELECT 1 FROM dbo.GLP1_Intake gi
                             WHERE gi.category=@category AND gi.member_key=m.k)`,
          { indx: id, category: cat, by: user.id || null });
      }
      return ok({ assigned: ids.length, records: affected, assigned_to: assignedTo });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

// Accept a single ?indx= or a body { indxs: [...] }
function idList(body, indxParam) {
  if (Array.isArray(body.indxs)) return body.indxs.map(n => parseInt(n, 10)).filter(Boolean);
  if (indxParam) return [parseInt(indxParam, 10)].filter(Boolean);
  return [];
}
