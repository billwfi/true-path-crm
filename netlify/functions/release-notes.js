const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

// Release Notes — a running dev log / changelog, tracked daily.
//   GET [?limit=N]  -> list, newest first
//   POST            -> { entry_date, title, category, body }
//   PATCH ?id=X     -> update
//   DELETE ?id=X    -> delete

const CATEGORIES = ['Feature', 'Fix', 'Improvement', 'Infra', 'Data'];

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { id, limit } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      const top = Math.min(parseInt(limit, 10) || 500, 2000);
      const r = await mssql(
        `SELECT TOP (${top}) n.id, n.entry_date, n.title, n.category, n.body, n.created_at,
                n.author_id, CONCAT(u.firstname, ' ', u.lastname) AS author_name
         FROM dbo.Release_Notes n
         LEFT JOIN dbo.Users u ON u.id = n.author_id
         ORDER BY n.entry_date DESC, n.id DESC`);
      return ok({ notes: r.recordset, categories: CATEGORIES });
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (!b.title) return badRequest('title required');
      const r = await mssql(
        `INSERT INTO dbo.Release_Notes (entry_date, title, category, body, author_id)
         VALUES (@date, @title, @category, @body, @uid);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { date: b.entry_date || new Date().toISOString().slice(0, 10),
          title: b.title, category: b.category || null, body: b.body || null, uid: user.id });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE dbo.Release_Notes SET entry_date=COALESCE(@date,entry_date),
           title=COALESCE(@title,title), category=@category, body=@body WHERE id=@id`,
        { date: b.entry_date || null, title: b.title || null, category: b.category ?? null,
          body: b.body ?? null, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM dbo.Release_Notes WHERE id=@id', { id: parseInt(id, 10) });
      return ok({ id });
    }

    return notFound();
  } catch (err) {
    return serverError(err);
  }
};
