const { verifyToken, unauthorized, ok, created, badRequest, serverError, options } = require('./_auth');
const { mssql } = require('./_mssql');
const { sendSms, e164 } = require('./_sms');

// SMS send + opt-out management (Azure Communication Services).
//   GET                     -> recent send log + config status
//   GET  ?resource=optouts  -> opt-out list
//   POST                    -> send { to, message, member_key? }   (admin only)
//   POST ?resource=optout   -> add an opt-out { phone, source? }
// ACS also auto-handles STOP/START/HELP for the number; this table is our own record.

function isAdmin(u) { return !!u && (u.user_type === 'Admin' || u.is_admin === true); }

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const { resource, limit } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (resource === 'optouts') {
        const r = await mssql('SELECT phone_number, opted_out_at, source FROM dbo.SMS_OptOut ORDER BY opted_out_at DESC');
        return ok(r.recordset);
      }
      const top = Math.min(parseInt(limit, 10) || 100, 1000);
      const r = await mssql(
        `SELECT TOP (${top}) id, to_number, from_number, message, status, error, member_key, created_at
         FROM dbo.SMS_Log ORDER BY id DESC`);
      return ok({
        log: r.recordset,
        from: process.env.SMS_FROM || null,
        configured: !!(process.env.ACS_CONNECTION_STRING && process.env.SMS_FROM),
      });
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (resource === 'optout') {
        const p = e164(b.phone);
        if (!p) return badRequest('phone required');
        await mssql(
          `IF NOT EXISTS (SELECT 1 FROM dbo.SMS_OptOut WHERE phone_number=@p)
             INSERT INTO dbo.SMS_OptOut (phone_number, source) VALUES (@p, @s)`,
          { p, s: (b.source || 'manual').slice(0, 30) });
        return created({ phone: p });
      }
      if (!isAdmin(user)) return unauthorized();
      if (!b.to || !b.message) return badRequest('to and message required');
      const res = await sendSms(b.to, b.message, { member_key: b.member_key, sent_by: user.id });
      return res.ok ? ok(res) : badRequest(res.error);
    }

    return badRequest('unsupported method');
  } catch (err) {
    return serverError(err);
  }
};
