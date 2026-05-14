const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'tp-crm-dev-secret';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

function verifyToken(event) {
  const auth = (event.headers.authorization || event.headers.Authorization || '').trim();
  if (!auth.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(auth.slice(7), SECRET);
  } catch {
    return null;
  }
}

function unauthorized() {
  return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
}

function ok(data) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
}

function created(data) {
  return { statusCode: 201, headers: CORS, body: JSON.stringify(data) };
}

function badRequest(msg) {
  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: msg }) };
}

function notFound(msg = 'Not found') {
  return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: msg }) };
}

function serverError(err) {
  console.error(err);
  return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server error', detail: String(err) }) };
}

function options() {
  return { statusCode: 204, headers: CORS, body: '' };
}

module.exports = { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options, CORS, SECRET };
