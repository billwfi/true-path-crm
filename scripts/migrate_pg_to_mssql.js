/* Migrate all Neon Postgres tables -> SQL Server (irx). Preserves IDs.
   Usage: DATABASE_URL=... node scripts/migrate_pg_to_mssql.js          (create + copy)
          DATABASE_URL=... node scripts/migrate_pg_to_mssql.js --verify (counts only) */
const { Pool } = require('pg');
const sql = require('mssql');

const pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const MSSQL = {
  server: '74.117.224.152', database: 'irx', user: 'claudeservices', password: 'Bunk?pjb8hah',
  options: { encrypt: true, trustServerCertificate: true }, pool: { max: 1, min: 1 },
  connectionTimeout: 30000, requestTimeout: 120000,
};

function mssqlType(c) {
  const L = c.character_maximum_length, P = c.numeric_precision, S = c.numeric_scale;
  switch (c.data_type) {
    case 'integer': return 'INT';
    case 'bigint': return 'BIGINT';
    case 'smallint': return 'SMALLINT';
    case 'boolean': return 'BIT';
    case 'date': return 'DATE';
    case 'timestamp without time zone': return 'DATETIME2';
    case 'timestamp with time zone': return 'DATETIMEOFFSET';
    case 'numeric': return P ? `DECIMAL(${P},${S || 0})` : 'DECIMAL(18,4)';
    case 'text': return 'NVARCHAR(MAX)';
    case 'character varying': return L ? `NVARCHAR(${L})` : 'NVARCHAR(255)';
    case 'character': return L ? `NCHAR(${L})` : 'NCHAR(1)';
    default: return 'NVARCHAR(255)';
  }
}
function defaultClause(c) {
  const d = (c.column_default || '').toLowerCase();
  if (!d || d.startsWith('nextval(')) return '';
  if (d.includes('now()') || d.includes('current_timestamp')) return ' DEFAULT SYSUTCDATETIME()';
  if (d === 'true') return ' DEFAULT 1';
  if (d === 'false') return ' DEFAULT 0';
  return '';
}
function sqlInputType(c) {
  switch (c.data_type) {
    case 'integer': case 'smallint': return sql.Int;
    case 'bigint': return sql.BigInt;
    case 'boolean': return sql.Bit;
    case 'date': return sql.Date;
    case 'timestamp without time zone': return sql.DateTime2;
    case 'timestamp with time zone': return sql.DateTimeOffset;
    case 'numeric': return sql.Decimal(c.numeric_precision || 18, c.numeric_scale || 4);
    case 'text': return sql.NVarChar(sql.MAX);
    case 'character varying': return c.character_maximum_length ? sql.NVarChar(c.character_maximum_length) : sql.NVarChar(255);
    case 'character': return sql.NChar(c.character_maximum_length || 1);
    default: return sql.NVarChar(255);
  }
}

function lit(val, c) {
  if (val === null || val === undefined) return 'NULL';
  switch (c.data_type) {
    case 'boolean': return val ? '1' : '0';
    case 'integer': case 'bigint': case 'smallint': case 'numeric': return String(val);
    case 'date': {
      const s = (val instanceof Date) ? val.toISOString().slice(0, 10) : String(val).slice(0, 10);
      return `'${s}'`;
    }
    case 'timestamp without time zone': {
      const d = new Date(val); return `'${d.toISOString().replace('T', ' ').replace('Z', '')}'`;
    }
    case 'timestamp with time zone': {
      const d = new Date(val); return `'${d.toISOString()}'`; // ISO8601 w/ Z -> datetimeoffset
    }
    default: return `N'${String(val).replace(/'/g, "''")}'`;
  }
}

(async () => {
  const verify = process.argv.includes('--verify');
  const pool = await new sql.ConnectionPool(MSSQL).connect();

  const tbls = (await pg.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map(r => r.table_name);

  for (const t of tbls) {
    const cols = (await pg.query(
      `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale,
              is_nullable, column_default
       FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t])).rows;
    const hasId = cols.some(c => c.column_name === 'id' && (c.data_type === 'integer' || c.data_type === 'bigint'));
    const rows = (await pg.query(`SELECT * FROM "${t}"`)).rows;

    if (verify) {
      const m = (await pool.request().query(`SELECT COUNT(*) n FROM [dbo].[${t}]`)).recordset[0].n;
      console.log(`${t}: pg=${rows.length} mssql=${m} ${rows.length === m ? 'OK' : 'MISMATCH'}`);
      continue;
    }

    // CREATE TABLE
    const defs = cols.map(c => {
      if (c.column_name === 'id' && hasId) return `[id] INT IDENTITY(1,1) PRIMARY KEY`;
      const nn = c.is_nullable === 'NO' && !c.column_default ? ' NOT NULL' : ' NULL';
      return `[${c.column_name}] ${mssqlType(c)}${defaultClause(c)}${nn}`;
    });
    await pool.request().query(`IF OBJECT_ID('dbo.${t}','U') IS NOT NULL DROP TABLE [dbo].[${t}];
      CREATE TABLE [dbo].[${t}] (${defs.join(', ')});`);

    // COPY rows as a single TDS batch (SET IDENTITY_INSERT + INSERTs guaranteed same session).
    if (rows.length) {
      const colNames = cols.map(c => c.column_name);
      const colList = colNames.map(n => `[${n}]`).join(',');
      const colTypes = Object.fromEntries(cols.map(c => [c.column_name, c]));
      let batch = hasId ? `SET IDENTITY_INSERT [dbo].[${t}] ON;\n` : '';
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const values = chunk.map(r => '(' + colNames.map(n => lit(r[n], colTypes[n])).join(',') + ')').join(',\n');
        batch += `INSERT INTO [dbo].[${t}] (${colList}) VALUES\n${values};\n`;
      }
      if (hasId) batch += `SET IDENTITY_INSERT [dbo].[${t}] OFF;\n`;
      await pool.request().batch(batch);
      if (hasId) {
        const maxId = Math.max(0, ...rows.map(r => r.id || 0));
        await pool.request().query(`DBCC CHECKIDENT('dbo.${t}', RESEED, ${maxId})`);
      }
    }
    console.log(`migrated ${t}: ${rows.length} rows`);
  }
  await pool.close(); await pg.end();
  console.log('DONE');
})().catch(e => { console.error('ERR', e); process.exit(1); });
