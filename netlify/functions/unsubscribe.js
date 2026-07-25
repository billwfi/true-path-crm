const { mssql } = require('./_mssql');
const { unsubToken } = require('./_email');

// Public (no auth) unsubscribe endpoint used by the /unsubscribe/ page.
//   GET  ?e=&t=  -> { email, opted_out, valid }
//   POST {e,t}   -> record opt-out + suppress pending campaign sends
const CORS = {
  'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const q = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      const email = (q.e || '').trim().toLowerCase();
      if (!email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing email' }) };
      const r = await mssql('SELECT 1 x FROM dbo.Email_OptOut WHERE email=@e', { e: email });
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ email, opted_out: r.recordset.length > 0, valid: (q.t || '') === unsubToken(email) }) };
    }
    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const email = (b.e || q.e || '').trim().toLowerCase();
      const t = b.t || q.t || '';
      if (!email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'missing email' }) };
      if (t !== unsubToken(email)) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'invalid token' }) };
      await mssql(
        `IF NOT EXISTS (SELECT 1 FROM dbo.Email_OptOut WHERE email=@e)
           INSERT INTO dbo.Email_OptOut (email, source) VALUES (@e, 'unsubscribe');
         UPDATE dbo.Email_Campaign_Recipients SET status='Suppressed' WHERE email=@e AND status='Pending';`,
        { e: email });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, email }) };
    }
    return { statusCode: 405, headers: CORS, body: '{}' };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server error' }) };
  }
};
