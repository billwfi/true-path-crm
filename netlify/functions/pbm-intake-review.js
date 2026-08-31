const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, notFound, serverError, options } = require('./_auth');

// Review queue for API-submitted PBM member records (dbo.PBM_Member_Intake).
//   GET                         -> list submissions (filters: status, search, pbm_id)
//   GET ?resource=counts        -> { New, Verified, Assigned, Rejected, total }
//   GET ?resource=concierges    -> active staff for the assignment dropdown
//   PATCH ?id=X                 -> { status, assigned_concierge_id, notes }  (verify / assign / reject)
const STATUSES = ['New', 'Verified', 'Assigned', 'Rejected'];

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const { id, resource, status, search, pbm_id } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (resource === 'counts') {
        const rows = (await mssql('SELECT Status, COUNT(*) n FROM dbo.PBM_Member_Intake GROUP BY Status')).recordset;
        const out = { New: 0, Verified: 0, Assigned: 0, Rejected: 0, total: 0 };
        rows.forEach(r => { out[r.Status] = r.n; out.total += r.n; });
        return ok(out);
      }
      if (resource === 'concierges') {
        // Unified concierge source: dbo.Users with the Client Concierge role — the same
        // people table the GLP1 / AMT & Assignment flow uses (was dbo.tp_staff).
        const r = await mssql(
          `SELECT id, LTRIM(RTRIM(CONCAT(firstname,' ',lastname))) AS name
           FROM dbo.Users WHERE active = 1 AND role = 'Client Concierge' ORDER BY firstname, lastname`);
        return ok(r.recordset);
      }
      const r = await mssql(
        `SELECT TOP 500 id, pbm_id, ReceivedAt, Source, Status, TPGroupID, GroupID, GroupName,
                CardholderID, PersonCode, LastName, FirstName, DateOfBirth, EmailAddress,
                AssignedConciergeId, AssignedConciergeName, VerifiedAt, ReviewNotes, RawJson
         FROM dbo.PBM_Member_Intake
         WHERE (@status IS NULL OR Status = @status)
           AND (@pbm IS NULL OR pbm_id = @pbm)
           AND (@s IS NULL OR LastName LIKE @s OR FirstName LIKE @s OR CardholderID LIKE @s
                OR GroupName LIKE @s OR TPGroupID LIKE @s)
         ORDER BY ReceivedAt DESC`,
        { status: STATUSES.includes(status) ? status : null,
          pbm: parseInt(pbm_id, 10) || null,
          s: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'PATCH') {
      const rid = parseInt(id, 10);
      if (!rid) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');

      let conciergeName = null;
      const cid = parseInt(b.assigned_concierge_id, 10) || null;
      if (cid) {
        const c = (await mssql(
          `SELECT LTRIM(RTRIM(CONCAT(firstname,' ',lastname))) AS name FROM dbo.Users WHERE id=@id`, { id: cid })).recordset[0];
        conciergeName = c ? c.name : null;
      }
      // Status: explicit, else derive (assigning => Assigned).
      let newStatus = STATUSES.includes(b.status) ? b.status : (cid ? 'Assigned' : null);
      const verifiedNow = newStatus === 'Verified' || newStatus === 'Assigned';

      const r = await mssql(
        `UPDATE dbo.PBM_Member_Intake
         SET Status = COALESCE(@status, Status),
             AssignedConciergeId   = CASE WHEN @setAssign=1 THEN @cid  ELSE AssignedConciergeId END,
             AssignedConciergeName = CASE WHEN @setAssign=1 THEN @cname ELSE AssignedConciergeName END,
             ReviewNotes = COALESCE(@notes, ReviewNotes),
             VerifiedBy  = CASE WHEN @verified=1 THEN @uid  ELSE VerifiedBy END,
             VerifiedAt  = CASE WHEN @verified=1 THEN SYSUTCDATETIME() ELSE VerifiedAt END
         OUTPUT INSERTED.id, INSERTED.Status, INSERTED.AssignedConciergeId, INSERTED.AssignedConciergeName, INSERTED.ReviewNotes
         WHERE id=@id`,
        { id: rid, status: newStatus, cid, cname: conciergeName,
          setAssign: b.assigned_concierge_id !== undefined ? 1 : 0,
          notes: b.notes != null ? b.notes : null,
          verified: verifiedNow ? 1 : 0, uid: user.id || null });
      return r.recordset[0] ? ok(r.recordset[0]) : notFound();
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
