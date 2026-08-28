-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices › Transactions: performance. The remote SQL server is slow, so parsing
-- the free-text date_ordered per row (TRY_CONVERT) and a correlated OUTER APPLY to
-- Eligibility_Liviniti made the summary/list/groups queries time out. Store a parsed,
-- indexed DATE (date_ordered_d) and index group_id; the API filters/sorts on those and
-- uses the stored resolved_company for the group label instead of the eligibility join.
--
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/044_uf_transactions_perf.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.tp_uf_transactions','date_ordered_d') IS NULL
  ALTER TABLE dbo.tp_uf_transactions ADD date_ordered_d DATE NULL;
GO

UPDATE dbo.tp_uf_transactions
   SET date_ordered_d = COALESCE(TRY_CONVERT(date, date_ordered, 101), TRY_CONVERT(date, LEFT(date_ordered,10), 23))
 WHERE date_ordered_d IS NULL AND NULLIF(LTRIM(RTRIM(date_ordered)),'') IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_uf_txn_dord')
  CREATE INDEX IX_uf_txn_dord ON dbo.tp_uf_transactions(date_ordered_d);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_uf_txn_group2')
  CREATE INDEX IX_uf_txn_group2 ON dbo.tp_uf_transactions(group_id);
GO
