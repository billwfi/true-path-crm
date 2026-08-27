-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices › Transactions: staging + payment log for transactions pulled from the
-- Unifeyed database (test data). Loaded by scripts/unifeyed/import_transactions.py.
--
--   tp_uf_transactions        one row per Unifeyed tbltransactions record, with the
--                             group normalized (COM<id> -> <id>) so it ties to our
--                             eligibility GroupID.
--   tp_uf_transaction_payments  payments logged against a transaction in this app.
--
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/042_uf_transactions.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.tp_uf_transactions','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_uf_transactions (
    id                  INT IDENTITY(1,1) PRIMARY KEY,
    source_id           INT           NOT NULL,      -- Unifeyed tbltransactions.id
    transaction_number  INT           NULL,
    order_number        NVARCHAR(250) NULL,
    customer_id         BIGINT        NULL,          -- Unifeyed tblclients.userid
    patient_first       NVARCHAR(150) NULL,
    patient_last        NVARCHAR(150) NULL,
    cardholder_id       NVARCHAR(50)  NULL,
    member_id           INT           NULL,
    person_code         NVARCHAR(50)  NULL,
    raw_group_id        NVARCHAR(50)  NULL,          -- as stored (e.g. COM130508)
    group_id            NVARCHAR(50)  NULL,          -- normalized (e.g. 130508)
    matches_eligibility BIT           NOT NULL DEFAULT 0,
    drug                NVARCHAR(255) NULL,
    strength            NVARCHAR(255) NULL,
    reporting_qty       DECIMAL(18,4) NULL,
    reporting_unit      NVARCHAR(100) NULL,
    unit_price          NVARCHAR(100) NULL,
    amount              DECIMAL(18,2) NULL,
    total_cost          DECIMAL(18,2) NULL,
    client_paid         DECIMAL(18,2) NULL,
    irx_paid            DECIMAL(18,2) NULL,
    vendor_paid         DECIMAL(18,2) NULL,
    status              NVARCHAR(100) NULL,
    order_status        NVARCHAR(500) NULL,
    is_paid             SMALLINT      NULL,
    date_ordered        NVARCHAR(100) NULL,
    shipped_date        NVARCHAR(100) NULL,
    delivery_date       NVARCHAR(100) NULL,
    imported_at         DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE UNIQUE INDEX UX_uf_txn_source ON dbo.tp_uf_transactions(source_id);
  CREATE INDEX IX_uf_txn_group ON dbo.tp_uf_transactions(group_id);
END
GO

IF OBJECT_ID('dbo.tp_uf_transaction_payments','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_uf_transaction_payments (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    transaction_id INT           NOT NULL,           -- FK dbo.tp_uf_transactions.id
    amount         DECIMAL(18,2) NOT NULL,
    paid_date      DATE          NULL,
    method         NVARCHAR(50)  NULL,               -- ACH, Check, Wire, Card, Other
    reference      NVARCHAR(191) NULL,               -- check #, ACH trace, etc.
    note           NVARCHAR(MAX) NULL,
    created_by     NVARCHAR(120) NULL,
    created_at     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_uf_pay_txn ON dbo.tp_uf_transaction_payments(transaction_id);
END
GO
