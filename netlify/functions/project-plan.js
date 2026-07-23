const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

// Project Plan — roadmap increments (categories) and their work items (tasks).
//   GET                          -> { categories:[{..., tasks:[...]}] }
//   POST ?resource=category      -> create category {code, title, goal}
//   POST                         -> create task {category_id, title, description, ref_tag, effort}
//   PATCH ?id=X                  -> update task {status, dev_notes, title, description, effort, category_id, sort_order}
//   PATCH ?resource=category&id  -> update category {title, goal, sort_order}
//   DELETE ?id=X                 -> delete task
//   DELETE ?resource=category&id -> delete category (and its tasks)

const STATUSES = ['Not Started', 'In Progress', 'Testing', 'Blocked', 'Done'];

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { id, resource } = event.queryStringParameters || {};
  const isCategory = resource === 'category';

  try {
    if (event.httpMethod === 'GET') {
      // Screenshot fetched on demand (excluded from the list to keep payload small).
      if (resource === 'screenshot') {
        if (!id) return badRequest('id required');
        const r = await mssql('SELECT screenshot FROM dbo.Project_Tasks WHERE id=@id', { id: parseInt(id, 10) });
        return r.recordset[0] ? ok({ screenshot: r.recordset[0].screenshot }) : notFound();
      }
      const cats = (await mssql(
        `SELECT id, code, title, goal, sort_order FROM dbo.Project_Categories ORDER BY sort_order, code`)).recordset;
      const tasks = (await mssql(
        `SELECT t.id, t.category_id, t.title, t.description, t.ref_tag, t.effort, t.status,
                t.dev_notes, t.source, t.page_url, t.sort_order, t.updated_at, t.created_at,
                CASE WHEN t.screenshot IS NOT NULL THEN 1 ELSE 0 END AS has_screenshot,
                CONCAT(u.firstname, ' ', u.lastname) AS updated_by_name
         FROM dbo.Project_Tasks t
         LEFT JOIN dbo.Users u ON u.id = t.updated_by
         ORDER BY t.sort_order, t.id`)).recordset;
      const byCat = {};
      for (const t of tasks) (byCat[t.category_id] = byCat[t.category_id] || []).push(t);
      for (const c of cats) c.tasks = byCat[c.id] || [];
      return ok({ categories: cats, statuses: STATUSES });
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      // In-app feedback -> a task under the Feedback category (screenshot + page url).
      if (resource === 'feedback') {
        const text = (b.text || '').trim();
        if (!text) return badRequest('feedback text required');
        const cat = await mssql(
          `IF NOT EXISTS (SELECT 1 FROM dbo.Project_Categories WHERE code='FB')
             INSERT INTO dbo.Project_Categories (code, title, goal, sort_order)
             VALUES ('FB','Feedback','In-app feedback captured from any page, with a screenshot.',0);
           SELECT id FROM dbo.Project_Categories WHERE code='FB';`);
        const catId = cat.recordset[0].id;
        const title = text.length > 90 ? text.slice(0, 90) + '…' : text;
        const r = await mssql(
          `INSERT INTO dbo.Project_Tasks (category_id, title, description, source, page_url, screenshot, status, updated_by, updated_at)
           VALUES (@cid,@title,@descr,'feedback',@url,@shot,'Not Started',@uid,GETDATE());
           SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
          { cid: catId, title, descr: text, url: (b.page_url || '').slice(0, 500),
            shot: b.screenshot || null, uid: user.id });
        return created({ id: r.recordset[0].id });
      }
      if (isCategory) {
        if (!b.title) return badRequest('title required');
        const r = await mssql(
          `INSERT INTO dbo.Project_Categories (code, title, goal, sort_order)
           VALUES (@code,@title,@goal,@sort);
           SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
          { code: b.code || '', title: b.title, goal: b.goal || null, sort: b.sort_order || 99 });
        return created({ id: r.recordset[0].id });
      }
      if (!b.category_id || !b.title) return badRequest('category_id and title required');
      const r = await mssql(
        `INSERT INTO dbo.Project_Tasks (category_id, title, description, ref_tag, effort, status, sort_order, updated_by, updated_at)
         VALUES (@cid,@title,@descr,@ref,@effort,@status,@sort,@uid,GETDATE());
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { cid: parseInt(b.category_id, 10), title: b.title, descr: b.description || null,
          ref: b.ref_tag || null, effort: b.effort || null,
          status: STATUSES.includes(b.status) ? b.status : 'Not Started',
          sort: b.sort_order || 99, uid: user.id });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      if (isCategory) {
        await mssql(
          `UPDATE dbo.Project_Categories SET title=COALESCE(@title,title), goal=@goal,
             sort_order=COALESCE(@sort,sort_order) WHERE id=@id`,
          { title: b.title || null, goal: b.goal ?? null, sort: b.sort_order ?? null, id: parseInt(id, 10) });
        return ok({ id });
      }
      // Build a partial update — only overwrite fields that were sent.
      await mssql(
        `UPDATE dbo.Project_Tasks SET
           status      = COALESCE(@status, status),
           dev_notes   = CASE WHEN @notes_set = 1 THEN @dev_notes ELSE dev_notes END,
           title       = COALESCE(@title, title),
           description = CASE WHEN @descr_set = 1 THEN @description ELSE description END,
           effort      = COALESCE(@effort, effort),
           category_id = COALESCE(@cid, category_id),
           sort_order  = COALESCE(@sort, sort_order),
           updated_by  = @uid, updated_at = GETDATE()
         WHERE id=@id`,
        { status: STATUSES.includes(b.status) ? b.status : null,
          notes_set: b.dev_notes !== undefined ? 1 : 0, dev_notes: b.dev_notes ?? null,
          title: b.title || null,
          descr_set: b.description !== undefined ? 1 : 0, description: b.description ?? null,
          effort: b.effort || null, cid: b.category_id ? parseInt(b.category_id, 10) : null,
          sort: b.sort_order ?? null, uid: user.id, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      if (isCategory) {
        await mssql('DELETE FROM dbo.Project_Tasks WHERE category_id=@id; DELETE FROM dbo.Project_Categories WHERE id=@id',
          { id: parseInt(id, 10) });
      } else {
        await mssql('DELETE FROM dbo.Project_Tasks WHERE id=@id', { id: parseInt(id, 10) });
      }
      return ok({ id });
    }

    return notFound();
  } catch (err) {
    return serverError(err);
  }
};
