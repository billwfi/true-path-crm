#!/usr/bin/env node
/*
 * Seed Client Concierge users into SQL Server dbo.Users.
 *
 * Creates each person below as:
 *   user_type  = 'User'
 *   role       = 'Client Concierge'
 *   nav_access = 'Call Center'   (the fixed nav lock for this role — see
 *                                 web/settings/user-management ROLE_NAV_LOCK)
 *   password   = TruePath2026!!  (bcrypt-hashed, same cost as the /users API)
 *   email      = <first-initial><lastname>@internationalrx.com (lowercased)
 *
 * Mirrors the /users POST endpoint: dbo.Users.id is NOT an identity column, so
 * each row allocates MAX(id)+1 explicitly.
 *
 * Idempotent: a person whose email already exists is skipped (never overwritten).
 *
 * Prereqs: SQLSERVER_HOST / SQLSERVER_USER / SQLSERVER_PASSWORD (and optionally
 *          SQLSERVER_DB, SQLSERVER_PORT) set in the environment.
 *
 * Usage:  node scripts/seed-concierges.js
 */
const sql = require('mssql');
const bcrypt = require('bcryptjs');

const PASSWORD = 'TruePath2026!!';
const DOMAIN = 'internationalrx.com';
const ROLE = 'Client Concierge';
const USER_TYPE = 'User';
const NAV_ACCESS = 'Call Center';

const PEOPLE = [
  'Ramon Sedano',
  'Alexa Chiarelli',
  'Cecilia Vargas',
  'Christine Brinson',
  'Laural Johnson',
  'Natalie Paige',
  'Alice Conde',
  'Estevan Campos',
  'Yoly Bryce',
  'Natalie Wooley',
  'Caroline Ndirangu',
  'Juanita Spivey',
];

// "Ramon Sedano" -> { firstname, lastname, email }.
// Email = first initial + full last name (no spaces), lowercased.
function toUser(fullName) {
  const parts = fullName.trim().split(/\s+/);
  const firstname = parts[0];
  const lastname = parts.slice(1).join(' ');
  const email = `${firstname[0]}${lastname.replace(/\s+/g, '')}`.toLowerCase() + `@${DOMAIN}`;
  return { firstname, lastname, email };
}

async function main() {
  if (!process.env.SQLSERVER_HOST) throw new Error('SQLSERVER_HOST not set');

  const pool = await new sql.ConnectionPool({
    server: process.env.SQLSERVER_HOST,
    database: process.env.SQLSERVER_DB || 'iRx',
    user: process.env.SQLSERVER_USER,
    password: process.env.SQLSERVER_PASSWORD,
    port: parseInt(process.env.SQLSERVER_PORT, 10) || 1433,
    options: { encrypt: true, trustServerCertificate: true },
    connectionTimeout: 20000,
  }).connect();

  const hash = await bcrypt.hash(PASSWORD, 10);

  let inserted = 0, skipped = 0;
  for (const person of PEOPLE) {
    const u = toUser(person);
    const res = await pool.request()
      .input('email', sql.NVarChar(255), u.email)
      .input('password_hash', sql.NVarChar(255), hash)
      .input('firstname', sql.NVarChar(100), u.firstname)
      .input('lastname', sql.NVarChar(100), u.lastname)
      .input('user_type', sql.NVarChar(20), USER_TYPE)
      .input('role', sql.NVarChar(50), ROLE)
      .input('nav_access', sql.NVarChar(500), NAV_ACCESS)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE email = @email)
        BEGIN
          DECLARE @newid INT = (SELECT ISNULL(MAX(id), 0) + 1 FROM dbo.Users);
          INSERT INTO dbo.Users (id, email, password_hash, firstname, lastname, user_type, role, nav_access, active)
          VALUES (@newid, @email, @password_hash, @firstname, @lastname, @user_type, @role, @nav_access, 1);
        END
      `);
    if (res.rowsAffected[res.rowsAffected.length - 1] > 0) {
      inserted++;
      console.log(`  + ${u.firstname} ${u.lastname} <${u.email}>`);
    } else {
      skipped++;
      console.log(`  · ${u.email} already exists — skipped`);
    }
  }

  console.log(`\nDone. Inserted ${inserted}, skipped ${skipped} (already present).`);
  await pool.close();
}

main().catch(err => { console.error('ERROR:', err.message || err); process.exit(1); });
