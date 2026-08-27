-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices › Transactions: resolve each staged transaction to a client/group.
-- The bridge is PBM_Groups.group_code = tp_uf_transactions.group_id (the eligibility
-- GroupID). That yields the TP group id, company, and PBM. Populated by
-- scripts/unifeyed/import_transactions.py after the load.
--
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/043_uf_transactions_resolve.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.tp_uf_transactions','resolved_group_pk') IS NULL
  ALTER TABLE dbo.tp_uf_transactions ADD resolved_group_pk INT NULL;      -- PBM_Groups.id
GO
IF COL_LENGTH('dbo.tp_uf_transactions','tp_group_id') IS NULL
  ALTER TABLE dbo.tp_uf_transactions ADD tp_group_id NVARCHAR(20) NULL;   -- e.g. TP1070
GO
IF COL_LENGTH('dbo.tp_uf_transactions','resolved_company') IS NULL
  ALTER TABLE dbo.tp_uf_transactions ADD resolved_company NVARCHAR(200) NULL;
GO
IF COL_LENGTH('dbo.tp_uf_transactions','resolved_pbm_id') IS NULL
  ALTER TABLE dbo.tp_uf_transactions ADD resolved_pbm_id INT NULL;
GO
