#!/usr/bin/env node
/*
 * One-time seed: copy Postgres tp_staff rows into SQL Server dbo.Users,
 * PRESERVING id values so every existing reference stays valid
 * (tp_clients.account_coordinator, tp_leads.assigned_id, tp_tasks.assigned_id,
 *  and GLP1 dbo.ReadyToAssign.assigned_to / assigned_by).
 *
 * Prereqs:
 *   1. Run netlify/database/sqlserver/001_users.sql first (creates dbo.Users).
 *   2. Set both DATABASE_URL (Postgres) and SQLSERVER_* env vars.
 *
 * Usage:  node scripts/seed-users.js
 *
 * Idempotent: existing dbo.Users rows (matched by id) are left untouched.
 */
const { Pool } = require('pg');
const sql = require('mssql');

// Sections existing (non-admin) users could already see before access control;
// preserve that so nobody loses access. Admins get NULL (see everything).
const DEFAULT_USER_NAV = 'Main,Pharmacy,GLP1,Admin';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  if (!process.env.SQLSERVER_HOST) throw new Error('SQLSERVER_HOST not set');

  const pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const mss = await new sql.ConnectionPool({
    server: process.env.SQLSERVER_HOST,
    database: process.env.SQLSERVER_DB || 'iRx',
    user: process.env.SQLSERVER_USER,
    password: process.env.SQLSERVER_PASSWORD,
    port: parseInt(process.env.SQLSERVER_PORT, 10) || 1433,
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();

  // tp_staff has no role column in some deployments; derive role from is_admin.
  const { rows } = await pg.query(
    'SELECT id, email, password_hash, firstname, lastname, is_admin FROM tp_staff ORDER BY id'
  );
  console.log(`Found ${rows.length} tp_staff rows in Postgres.`);

  let inserted = 0, skipped = 0;
  for (const u of rows) {
    const userType = u.is_admin ? 'Admin' : 'User';
    const role = u.is_admin ? 'Admin' : 'Staff';
    const navAccess = u.is_admin ? null : DEFAULT_USER_NAV;
    const res = await mss.request()
      .input('id', sql.Int, u.id)
      .input('email', sql.NVarChar(255), u.email)
      .input('password_hash', sql.NVarChar(255), u.password_hash)
      .input('firstname', sql.NVarChar(100), u.firstname)
      .input('lastname', sql.NVarChar(100), u.lastname)
      .input('user_type', sql.NVarChar(20), userType)
      .input('role', sql.NVarChar(50), role)
      .input('nav_access', sql.NVarChar(500), navAccess)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE id = @id)
          INSERT INTO dbo.Users (id, email, password_hash, firstname, lastname, user_type, role, nav_access, active)
          VALUES (@id, @email, @password_hash, @firstname, @lastname, @user_type, @role, @nav_access, 1);
      `);
    if (res.rowsAffected[0] > 0) { inserted++; console.log(`  + ${u.email} (id ${u.id}, ${userType})`); }
    else { skipped++; }
  }

  console.log(`\nDone. Inserted ${inserted}, skipped ${skipped} (already present).`);
  await pg.end();
  await mss.close();
}

main().catch(err => { console.error(err); process.exit(1); });
