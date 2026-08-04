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
      // Attachment metadata for a task/sub-task (no payload).
      if (resource === 'attachments') {
        const tid = (event.queryStringParameters || {}).task_id;
        if (!tid) return badRequest('task_id required');
        const r = await mssql(
          `SELECT id, task_id, filename, content_type, size_bytes, uploaded_at,
                  CONCAT(u.firstname,' ',u.lastname) AS uploaded_by_name
           FROM dbo.Project_Task_Attachments a LEFT JOIN dbo.Users u ON u.id = a.uploaded_by
           WHERE a.task_id=@t ORDER BY a.uploaded_at DESC`, { t: parseInt(tid, 10) });
        return ok({ attachments: r.recordset });
      }
      // Single attachment with its base64 payload (for download).
      if (resource === 'attachment') {
        if (!id) return badRequest('id required');
        const r = await mssql(
          'SELECT filename, content_type, data_b64 FROM dbo.Project_Task_Attachments WHERE id=@id',
          { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const cats = (await mssql(
        `SELECT id, code, title, goal, sort_order, [plan],
                CONVERT(varchar(10), start_date, 23) AS start_date,
                CONVERT(varchar(10), end_date, 23)   AS end_date
         FROM dbo.Project_Categories ORDER BY sort_order, code`)).recordset;
      const tasks = (await mssql(
        `SELECT t.id, t.category_id, t.parent_task_id, t.title, t.description, t.ref_tag, t.effort, t.status,
                t.dev_notes, t.source, t.page_url, t.assignee,
                CONVERT(varchar(10), t.due_date, 23) AS due_date,
                t.sort_order, t.updated_at, t.created_at,
                CASE WHEN t.screenshot IS NOT NULL THEN 1 ELSE 0 END AS has_screenshot,
                (SELECT COUNT(*) FROM dbo.Project_Task_Attachments a WHERE a.task_id = t.id) AS attachment_count,
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
          `INSERT INTO dbo.Project_Categories (code, title, goal, sort_order, [plan], start_date, end_date)
           VALUES (@code,@title,@goal,@sort,@plan,@sd,@ed);
           SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
          { code: b.code || '', title: b.title, goal: b.goal || null, sort: b.sort_order || 99,
            plan: b.plan || 'New Development', sd: b.start_date || null, ed: b.end_date || null });
        return created({ id: r.recordset[0].id });
      }
      // Upload a document attachment onto a task/sub-task (base64 payload).
      if (resource === 'attachment') {
        if (!b.task_id || !b.filename || !b.data_b64) return badRequest('task_id, filename, data_b64 required');
        const r = await mssql(
          `INSERT INTO dbo.Project_Task_Attachments (task_id, filename, content_type, size_bytes, data_b64, uploaded_by)
           VALUES (@t,@fn,@ct,@sz,@d,@uid);
           SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
          { t: parseInt(b.task_id, 10), fn: (b.filename || '').slice(0, 260),
            ct: b.content_type || null, sz: b.size_bytes || null, d: b.data_b64, uid: user.id });
        return created({ id: r.recordset[0].id });
      }
      if (!b.category_id || !b.title) return badRequest('category_id and title required');
      const r = await mssql(
        `INSERT INTO dbo.Project_Tasks (category_id, parent_task_id, title, description, ref_tag, effort,
           status, assignee, due_date, sort_order, updated_by, updated_at)
         VALUES (@cid,@parent,@title,@descr,@ref,@effort,@status,@assignee,@due,@sort,@uid,GETDATE());
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { cid: parseInt(b.category_id, 10), parent: b.parent_task_id ? parseInt(b.parent_task_id, 10) : null,
          title: b.title, descr: b.description || null,
          ref: b.ref_tag || null, effort: b.effort || null,
          status: STATUSES.includes(b.status) ? b.status : 'Not Started',
          assignee: b.assignee || null, due: b.due_date || null,
          sort: b.sort_order || 99, uid: user.id });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      if (isCategory) {
        await mssql(
          `UPDATE dbo.Project_Categories SET title=COALESCE(@title,title), goal=@goal,
             sort_order=COALESCE(@sort,sort_order), [plan]=COALESCE(@plan,[plan]),
             start_date=CASE WHEN @sd_set=1 THEN @sd ELSE start_date END,
             end_date=CASE WHEN @ed_set=1 THEN @ed ELSE end_date END
           WHERE id=@id`,
          { title: b.title || null, goal: b.goal ?? null, sort: b.sort_order ?? null,
            plan: b.plan || null,
            sd_set: b.start_date !== undefined ? 1 : 0, sd: b.start_date || null,
            ed_set: b.end_date !== undefined ? 1 : 0, ed: b.end_date || null,
            id: parseInt(id, 10) });
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
           assignee    = CASE WHEN @asg_set = 1 THEN @assignee ELSE assignee END,
           due_date    = CASE WHEN @due_set = 1 THEN @due ELSE due_date END,
           category_id = COALESCE(@cid, category_id),
           sort_order  = COALESCE(@sort, sort_order),
           updated_by  = @uid, updated_at = GETDATE()
         WHERE id=@id`,
        { status: STATUSES.includes(b.status) ? b.status : null,
          notes_set: b.dev_notes !== undefined ? 1 : 0, dev_notes: b.dev_notes ?? null,
          title: b.title || null,
          descr_set: b.description !== undefined ? 1 : 0, description: b.description ?? null,
          effort: b.effort || null,
          asg_set: b.assignee !== undefined ? 1 : 0, assignee: b.assignee ?? null,
          due_set: b.due_date !== undefined ? 1 : 0, due: b.due_date || null,
          cid: b.category_id ? parseInt(b.category_id, 10) : null,
          sort: b.sort_order ?? null, uid: user.id, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      if (resource === 'attachment') {
        await mssql('DELETE FROM dbo.Project_Task_Attachments WHERE id=@id', { id: parseInt(id, 10) });
        return ok({ id });
      }
      if (isCategory) {
        await mssql(
          `DELETE FROM dbo.Project_Task_Attachments WHERE task_id IN (SELECT id FROM dbo.Project_Tasks WHERE category_id=@id);
           DELETE FROM dbo.Project_Tasks WHERE category_id=@id;
           DELETE FROM dbo.Project_Categories WHERE id=@id`,
          { id: parseInt(id, 10) });
      } else {
        // Deleting a task removes its sub-tasks and all their attachments too.
        await mssql(
          `DELETE FROM dbo.Project_Task_Attachments WHERE task_id=@id OR task_id IN (SELECT id FROM dbo.Project_Tasks WHERE parent_task_id=@id);
           DELETE FROM dbo.Project_Tasks WHERE parent_task_id=@id;
           DELETE FROM dbo.Project_Tasks WHERE id=@id`,
          { id: parseInt(id, 10) });
      }
      return ok({ id });
    }

    return notFound();
  } catch (err) {
    return serverError(err);
  }
};
