const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

// Client Concierge intake engine — intake-type taxonomy (dbo.tp_intake_types).
//   GET [?code=X]        -> list types (or one)
//   POST                 -> create { code, name, description, statuses[], sub_statuses{}, color, is_glp1, active, sort_order }
//   PATCH ?code=X        -> update
//   DELETE ?code=X       -> delete

const jstr = (v) => (v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)));

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const { code } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (code) {
        const r = await mssql('SELECT * FROM dbo.tp_intake_types WHERE code=@c', { c: code });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql('SELECT * FROM dbo.tp_intake_types ORDER BY sort_order, code');
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (!b.code || !b.name) return badRequest('code and name required');
      await mssql(
        `IF EXISTS (SELECT 1 FROM dbo.tp_intake_types WHERE code=@code) SELECT 1;
         ELSE INSERT INTO dbo.tp_intake_types (code,name,description,statuses,sub_statuses,color,is_glp1,active,sort_order)
              VALUES (@code,@name,@descr,@st,@sub,@color,@glp,@active,@sort);`,
        { code: String(b.code).toUpperCase().slice(0, 20), name: b.name, descr: b.description || null,
          st: jstr(b.statuses), sub: jstr(b.sub_statuses), color: b.color || null,
          glp: b.is_glp1 ? 1 : 0, active: (b.active === false || b.active === 0) ? 0 : 1, sort: parseInt(b.sort_order, 10) || 100 });
      return created({ code: b.code });
    }

    if (event.httpMethod === 'PATCH') {
      if (!code) return badRequest('code required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE dbo.tp_intake_types SET name=COALESCE(@name,name),
           description=CASE WHEN @descr_set=1 THEN @descr ELSE description END,
           statuses=CASE WHEN @st_set=1 THEN @st ELSE statuses END,
           sub_statuses=CASE WHEN @sub_set=1 THEN @sub ELSE sub_statuses END,
           color=CASE WHEN @color_set=1 THEN @color ELSE color END,
           is_glp1=COALESCE(@glp,is_glp1), active=COALESCE(@active,active),
           sort_order=COALESCE(@sort,sort_order), updated_at=SYSUTCDATETIME()
         WHERE code=@code`,
        { name: b.name || null,
          descr_set: b.description !== undefined ? 1 : 0, descr: b.description ?? null,
          st_set: b.statuses !== undefined ? 1 : 0, st: jstr(b.statuses),
          sub_set: b.sub_statuses !== undefined ? 1 : 0, sub: jstr(b.sub_statuses),
          color_set: b.color !== undefined ? 1 : 0, color: b.color ?? null,
          glp: b.is_glp1 === true ? 1 : b.is_glp1 === false ? 0 : null,
          active: b.active === true ? 1 : b.active === false ? 0 : null,
          sort: (b.sort_order !== undefined ? parseInt(b.sort_order, 10) : null),
          code });
      return ok({ code });
    }

    if (event.httpMethod === 'DELETE') {
      if (!code) return badRequest('code required');
      await mssql('DELETE FROM dbo.tp_intake_types WHERE code=@code', { code });
      return ok({ code });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
