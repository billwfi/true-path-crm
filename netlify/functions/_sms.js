// SMS via Azure Communication Services. Inert until ACS_CONNECTION_STRING and
// SMS_FROM are set (so it's safe to deploy before the number is verified).
const { SmsClient } = require('@azure/communication-sms');
const { mssql } = require('./_mssql');

let _client;
function getClient() {
  const cs = process.env.ACS_CONNECTION_STRING;
  if (!cs) return null;
  if (!_client) _client = new SmsClient(cs);
  return _client;
}

// Normalize to E.164 (US default).
function e164(n) {
  const d = String(n || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d ? '+' + d : '';
}

async function isOptedOut(dest) {
  const r = await mssql('SELECT 1 AS x FROM dbo.SMS_OptOut WHERE phone_number = @p', { p: dest });
  return r.recordset.length > 0;
}

// Send one SMS. Checks the opt-out list, sends via ACS, and logs the attempt.
async function sendSms(to, message, ctx = {}) {
  const client = getClient();
  const from = process.env.SMS_FROM;
  if (!client || !from) return { ok: false, error: 'SMS not configured (ACS_CONNECTION_STRING / SMS_FROM)' };
  const dest = e164(to);
  if (!dest) return { ok: false, error: 'invalid destination number' };
  if (await isOptedOut(dest)) return { ok: false, error: 'recipient opted out' };

  let status = 'sent', messageId = null, err = null;
  try {
    const results = await client.send(
      { from, to: [dest], message },
      { enableDeliveryReport: true });
    const r = results[0] || {};
    messageId = r.messageId || null;
    if (!r.successful) { status = 'failed'; err = r.errorMessage || ('http ' + r.httpStatusCode); }
  } catch (e) {
    status = 'error'; err = e.message;
  }
  await mssql(
    `INSERT INTO dbo.SMS_Log (to_number, from_number, message, message_id, status, error, member_key, sent_by)
     VALUES (@to,@from,@msg,@mid,@st,@err,@mk,@by)`,
    { to: dest, from, msg: message, mid: messageId, st: status, err,
      mk: ctx.member_key || null, by: ctx.sent_by || null });
  return { ok: status === 'sent', status, messageId, error: err };
}

module.exports = { sendSms, e164, isOptedOut };
