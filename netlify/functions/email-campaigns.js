const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');
const { sendEmail, render } = require('./_email');

// Email campaigns: create, import recipients, batched send, and stats.
//   GET                              -> list campaigns (+ counts)
//   GET  ?id=X                       -> one campaign + status stats + per-company progress
//   POST                             -> create { name, template_en, template_es, default_lang, from_address }
//   POST ?resource=recipients&id=X   -> import [{company_name,first_name,last_name,email,language}]
//   POST ?resource=send&id=X&count=N -> send up to N pending (admin) — call repeatedly to pace
//   PATCH ?id=X                      -> { status } (pause/resume)
//   DELETE ?id=X

function isAdmin(u) { return !!u && (u.user_type === 'Admin' || u.is_admin === true); }
const UNSUB = 'https://app.truepathsourcing.com/unsubscribe';

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const { id, resource, count } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const c = (await mssql('SELECT * FROM dbo.Email_Campaigns WHERE id=@id', { id: +id })).recordset[0];
        if (!c) return notFound();
        const stats = (await mssql(
          'SELECT status, COUNT(*) n FROM dbo.Email_Campaign_Recipients WHERE campaign_id=@id GROUP BY status', { id: +id })).recordset;
        const companies = (await mssql(
          `SELECT company_name, COUNT(*) total,
                  SUM(CASE WHEN status<>'Pending' THEN 1 ELSE 0 END) sent,
                  SUM(CASE WHEN status='Delivered' THEN 1 ELSE 0 END) delivered,
                  SUM(CASE WHEN status='Bounced' THEN 1 ELSE 0 END) bounced
           FROM dbo.Email_Campaign_Recipients WHERE campaign_id=@id GROUP BY company_name ORDER BY company_name`, { id: +id })).recordset;
        return ok({ campaign: c, stats, companies });
      }
      const r = await mssql(
        `SELECT c.*,
                (SELECT COUNT(*) FROM dbo.Email_Campaign_Recipients r WHERE r.campaign_id=c.id) recipients,
                (SELECT COUNT(*) FROM dbo.Email_Campaign_Recipients r WHERE r.campaign_id=c.id AND r.status<>'Pending') sent
         FROM dbo.Email_Campaigns c ORDER BY c.id DESC`);
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');

      if (resource === 'recipients') {
        if (!id) return badRequest('id required');
        const json = JSON.stringify(b.recipients || []);
        const r = await mssql(
          `INSERT INTO dbo.Email_Campaign_Recipients (campaign_id, company_name, first_name, last_name, email, language)
           SELECT @cid, x.company_name, x.first_name, x.last_name, LTRIM(RTRIM(x.email)), x.language
           FROM OPENJSON(@json) WITH (company_name nvarchar(200), first_name nvarchar(100),
                last_name nvarchar(100), email nvarchar(200), language nvarchar(5)) x
           WHERE x.email IS NOT NULL AND CHARINDEX('@', x.email) > 0 AND x.email NOT LIKE '%noemail%'
             AND NOT EXISTS (SELECT 1 FROM dbo.Email_Campaign_Recipients r
                             WHERE r.campaign_id=@cid AND r.email = LTRIM(RTRIM(x.email)));
           SELECT COUNT(*) n FROM dbo.Email_Campaign_Recipients WHERE campaign_id=@cid;`,
          { cid: +id, json });
        return ok({ total: r.recordset[0].n });
      }

      if (resource === 'send') {
        if (!isAdmin(user)) return unauthorized();
        if (!id) return badRequest('id required');
        const c = (await mssql('SELECT * FROM dbo.Email_Campaigns WHERE id=@id', { id: +id })).recordset[0];
        if (!c) return notFound();
        if (c.status === 'Paused') return badRequest('campaign is paused');
        const n = Math.min(parseInt(count, 10) || 20, 50);
        const tpls = {};
        for (const k of [c.template_en, c.template_es].filter(Boolean)) {
          tpls[k] = (await mssql('SELECT subject, html_body FROM dbo.Email_Templates WHERE tkey=@k', { k })).recordset[0];
        }
        const recips = (await mssql(
          `SELECT TOP (${n}) * FROM dbo.Email_Campaign_Recipients WHERE campaign_id=@id AND status='Pending' ORDER BY id`, { id: +id })).recordset;
        let sent = 0, failed = 0;
        for (const r of recips) {
          const isEs = String(r.language || c.default_lang || 'en').toLowerCase().startsWith('es');
          const tk = isEs ? (c.template_es || c.template_en) : (c.template_en || c.template_es);
          const t = tpls[tk];
          if (!t) { failed++; continue; }
          const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Member';
          const html = render(t.html_body, { member_name: name, unsubscribe_url: UNSUB + '?e=' + encodeURIComponent(r.email) });
          const res = await sendEmail({ to: r.email, subject: t.subject, html, from: c.from_address });
          if (res.ok) {
            sent++;
            await mssql(`UPDATE dbo.Email_Campaign_Recipients SET status='Sent', message_id=@m, sent_at=GETDATE(), error=NULL WHERE id=@rid`,
              { m: res.messageId || null, rid: r.id });
          } else {
            failed++;
            await mssql(`UPDATE dbo.Email_Campaign_Recipients SET status='Failed', error=@e WHERE id=@rid`,
              { e: (res.error || '').slice(0, 400), rid: r.id });
          }
        }
        const rem = (await mssql(`SELECT COUNT(*) n FROM dbo.Email_Campaign_Recipients WHERE campaign_id=@id AND status='Pending'`, { id: +id })).recordset[0].n;
        await mssql(`UPDATE dbo.Email_Campaigns SET status=@s, sent_at=COALESCE(sent_at,GETDATE()) WHERE id=@id`,
          { s: rem > 0 ? 'Sending' : 'Sent', id: +id });
        return ok({ sent, failed, remaining: rem });
      }

      if (!b.name) return badRequest('name required');
      const r = await mssql(
        `INSERT INTO dbo.Email_Campaigns (name, template_en, template_es, default_lang, from_address, created_by)
         VALUES (@n,@te,@ts,@dl,@fr,@by); SELECT CAST(SCOPE_IDENTITY() AS INT) id;`,
        { n: b.name, te: b.template_en || 'rebrand-en', ts: b.template_es || 'rebrand-es',
          dl: b.default_lang || 'en', fr: b.from_address || 'noreply@truepathsourcing.com', by: user.id });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql('UPDATE dbo.Email_Campaigns SET status=COALESCE(@s,status) WHERE id=@id',
        { s: b.status || null, id: +id });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM dbo.Email_Campaign_Recipients WHERE campaign_id=@id; DELETE FROM dbo.Email_Campaigns WHERE id=@id', { id: +id });
      return ok({ id });
    }

    return badRequest('unsupported');
  } catch (err) {
    return serverError(err);
  }
};
