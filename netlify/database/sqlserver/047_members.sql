-- ─────────────────────────────────────────────────────────────────────────────
-- Member profiles & medication history migrated from Unifeyed, plus a link from
-- the app's clients (tp_clients) to the Unifeyed company they came from.
--   tp_clients.uf_company_id   bridge to the migrated Unifeyed company
--   tp_uf_members              member/patient profiles (tblclients, 6,569)
--   tp_member_medications      per-member medication/Rx history (tblmedications, 10,157)
--
-- Loaded by scripts/procurement/import_members.py.
-- Run with: node scripts/run-sql.js netlify/database/sqlserver/047_members.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.tp_clients','uf_company_id') IS NULL
  ALTER TABLE dbo.tp_clients ADD uf_company_id INT NULL;
GO

IF OBJECT_ID('dbo.tp_uf_members','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_uf_members (
    member_source_id  BIGINT        NOT NULL PRIMARY KEY,   -- Unifeyed tblclients.userid
    uf_company_id     INT           NULL,                   -- -> tp_uf_companies.company_id
    first_name        NVARCHAR(100) NULL,
    last_name         NVARCHAR(100) NULL,
    gender            NVARCHAR(20)  NULL,
    date_of_birth     NVARCHAR(40)  NULL,
    member_id         NVARCHAR(50)  NULL,
    cardholder_id     NVARCHAR(50)  NULL,
    group_id          NVARCHAR(50)  NULL,
    person_code       NVARCHAR(10)  NULL,
    relationship_code NVARCHAR(20)  NULL,
    email             NVARCHAR(150) NULL,
    phone             NVARCHAR(50)  NULL,
    address           NVARCHAR(200) NULL,
    city              NVARCHAR(100) NULL,
    state             NVARCHAR(50)  NULL,
    zip               NVARCHAR(20)  NULL,
    enrollment_status NVARCHAR(60)  NULL,
    eligible_thru     NVARCHAR(40)  NULL,
    active            BIT           NULL,
    imported_at       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_tp_uf_members_co ON dbo.tp_uf_members(uf_company_id);
  CREATE INDEX IX_tp_uf_members_name ON dbo.tp_uf_members(last_name, first_name);
END
GO

IF OBJECT_ID('dbo.tp_member_medications','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_member_medications (
    id                 INT IDENTITY(1,1) PRIMARY KEY,
    source_id          INT           NULL,   -- tblmedications.id
    member_source_id   BIGINT        NULL,   -- -> tp_uf_members.member_source_id
    product_source_id  INT           NULL,   -- -> tp_products.source_id
    strength           NVARCHAR(100) NULL,
    day_supply         NVARCHAR(40)  NULL,
    number_of_refills  NVARCHAR(20)  NULL,
    next_fill_order_date NVARCHAR(40) NULL,
    ndc_code           NVARCHAR(40)  NULL,
    reporting_unit     NVARCHAR(60)  NULL,
    reporting_qty      DECIMAL(18,4) NULL,
    inactive           BIT           NULL,
    imported_at        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE UNIQUE INDEX UX_tp_member_meds_src ON dbo.tp_member_medications(source_id) WHERE source_id IS NOT NULL;
  CREATE INDEX IX_tp_member_meds_member ON dbo.tp_member_medications(member_source_id);
END
GO
