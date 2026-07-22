/*
 * True Path CRM — container entrypoint.
 *
 * Serves the static `web/` site AND runs the Netlify Functions in
 * `netlify/functions/` unchanged, behind a thin adapter that maps an Express
 * request to the Netlify handler contract:
 *
 *     exports.handler(event, context) -> { statusCode, headers, body }
 *
 * The frontend keeps calling `/.netlify/functions/<name>` exactly as it did on
 * Netlify, so no frontend or function code changes are needed. This replaces
 * netlify.toml: the trailing-slash redirects and security headers are ported to
 * middleware below.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8080;

const WEB_DIR = path.join(__dirname, 'web');
const FUNCTIONS_DIR = path.join(__dirname, 'netlify', 'functions');

// ── Discover callable functions ────────────────────────────────────────────
// Endpoints are the non-underscore *.js files; `_*.js` are shared helpers and
// are never invoked directly. Building the set up front also prevents a crafted
// path from `require`-ing anything outside this directory.
const FUNCTIONS = new Set(
  fs.readdirSync(FUNCTIONS_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .map((f) => f.slice(0, -3))
);
console.log(`Loaded ${FUNCTIONS.size} functions: ${[...FUNCTIONS].sort().join(', ')}`);

// ── Security headers (was netlify.toml [[headers]]) ─────────────────────────
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// ── Function adapter ────────────────────────────────────────────────────────
// Capture the raw body as a string for every content type: functions do
// `JSON.parse(event.body)` themselves and file uploads arrive as base64 in
// JSON, so we must not pre-parse. 50mb covers spreadsheet imports.
app.use('/.netlify/functions', express.raw({ type: '*/*', limit: '50mb' }));

app.all('/.netlify/functions/:name', async (req, res) => {
  const { name } = req.params;
  if (!FUNCTIONS.has(name)) {
    return res.status(404).json({ error: `Function not found: ${name}` });
  }

  // Netlify's queryStringParameters is a flat string->string map (last wins).
  const query = {};
  for (const [k, v] of Object.entries(req.query)) {
    query[k] = Array.isArray(v) ? String(v[v.length - 1]) : String(v);
  }

  const event = {
    httpMethod: req.method,
    headers: req.headers, // Express lowercases keys, matching Netlify
    queryStringParameters: query,
    body: Buffer.isBuffer(req.body) && req.body.length ? req.body.toString('utf8') : '',
    isBase64Encoded: false,
    path: req.path,
  };

  try {
    const { handler } = require(path.join(FUNCTIONS_DIR, `${name}.js`));
    const result = await handler(event, {});
    const { statusCode = 200, headers = {}, body = '' } = result || {};
    res.status(statusCode).set(headers).send(body);
  } catch (err) {
    console.error(`Function ${name} threw:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Static site (was netlify.toml publish = "web") ──────────────────────────
// Mirror Netlify's clean-URL behavior: 301 an extensionless path with no
// trailing slash to the slashed form when a real directory backs it, so
// `/dashboard` -> `/dashboard/` -> web/dashboard/index.html.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path;
  if (p === '/' || p.endsWith('/') || path.extname(p)) return next();
  const dir = path.join(WEB_DIR, p);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    return res.redirect(301, p + '/');
  }
  next();
});

app.use(express.static(WEB_DIR, { extensions: ['html'], index: 'index.html' }));

// Unmatched GETs fall back to the SPA-style 404 / index handling of the site.
app.use((req, res) => {
  res.status(404).sendFile(path.join(WEB_DIR, 'index.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

app.listen(PORT, () => {
  console.log(`True Path CRM listening on :${PORT}`);
});
