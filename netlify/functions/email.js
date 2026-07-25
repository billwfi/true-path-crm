const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, notFound, serverError, options } = require('./_auth');
const { sendEmail, render } = require('./_email');

// Marketing email — templates + test send (campaign send/tracking is separate).
//   GET                          -> { from, configured }
//   GET  ?resource=templates     -> list templates
//   PATCH ?resource=template&id  -> update { name, subject, html_body }
//   POST ?resource=test          -> send a test { to, tkey }  (uses sample merge values)

const SAMPLE = { member_name: 'Member', unsubscribe_url: 'https://app.truepathsourcing.com/unsubscribe' };

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const { resource, id } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (resource === 'templates') {
        const r = await mssql(
          `SELECT id, tkey, name, language, subject, html_body, updated_at FROM dbo.Email_Templates ORDER BY language, name`);
        return ok(r.recordset);
      }
      return ok({ from: process.env.EMAIL_FROM || 'noreply@truepathsourcing.com',
                  configured: !!process.env.ACS_CONNECTION_STRING });
    }

    if (event.httpMethod === 'PATCH' && resource === 'template') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE dbo.Email_Templates SET name=COALESCE(@name,name), subject=COALESCE(@subject,subject),
           html_body=COALESCE(@html,html_body), updated_by=@uid, updated_at=GETDATE() WHERE id=@id`,
        { name: b.name || null, subject: b.subject || null, html: b.html_body || null,
          uid: user.id, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'POST' && resource === 'test') {
      const b = JSON.parse(event.body || '{}');
      if (!b.to || !b.tkey) return badRequest('to and tkey required');
      const t = (await mssql('SELECT subject, html_body FROM dbo.Email_Templates WHERE tkey=@k', { k: b.tkey })).recordset[0];
      if (!t) return notFound('template not found');
      const res = await sendEmail({
        to: b.to, subject: '[TEST] ' + t.subject, html: render(t.html_body, SAMPLE) });
      return res.ok ? ok(res) : badRequest(res.error);
    }

    return badRequest('unsupported');
  } catch (err) {
    return serverError(err);
  }
};
