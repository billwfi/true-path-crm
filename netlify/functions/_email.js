// Email via Azure Communication Services. Inert until ACS_CONNECTION_STRING is
// set and the sender domain is verified/linked.
const { EmailClient } = require('@azure/communication-email');

let _client;
function getClient() {
  const cs = process.env.ACS_CONNECTION_STRING;
  if (!cs) return null;
  if (!_client) _client = new EmailClient(cs);
  return _client;
}

// Simple {{field}} substitution.
function render(html, vars = {}) {
  return String(html || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

// Send one email. Returns { ok, messageId, status, error }.
async function sendEmail({ to, subject, html, from, displayName }) {
  const client = getClient();
  const sender = from || process.env.EMAIL_FROM || 'noreply@truepathsourcing.com';
  if (!client) return { ok: false, error: 'Email not configured (ACS_CONNECTION_STRING)' };
  if (!to || !subject || !html) return { ok: false, error: 'to, subject, html required' };
  try {
    const poller = await client.beginSend({
      senderAddress: sender,
      content: { subject, html },
      recipients: { to: [{ address: to, displayName: displayName || undefined }] },
    });
    const res = await poller.pollUntilDone();
    return { ok: res.status === 'Succeeded', status: res.status, messageId: res.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendEmail, render };
