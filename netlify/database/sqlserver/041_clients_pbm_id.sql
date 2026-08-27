-- ─────────────────────────────────────────────────────────────────────────────
-- Clients › Demographics: associate a client with a PBM (tp_pbms).
-- Adds tp_clients.pbm_id, populated from the PBM dropdown on the Client Record.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/041_clients_pbm_id.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.tp_clients', 'pbm_id') IS NULL
  ALTER TABLE dbo.tp_clients ADD pbm_id INT NULL;
GO
