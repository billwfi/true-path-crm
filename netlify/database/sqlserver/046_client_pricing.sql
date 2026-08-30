-- ─────────────────────────────────────────────────────────────────────────────
-- Procurement › Client Pricing, Rebates & Formulary. Foundational masters migrated
-- from Unifeyed (tblcompanies / tblcompany_pricing / tblcompanies_assigned_products).
--   tp_uf_companies    the client/employer companies (546)
--   tp_client_pricing  per-company drug price + rebate (1,730)
--   tp_client_formulary  per-company approved-product list (JSON, ~638)
--
-- Loaded by scripts/procurement/import_pricing.py.
-- Run with: node scripts/run-sql.js netlify/database/sqlserver/046_client_pricing.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.tp_uf_companies','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_uf_companies (
    company_id            INT           NOT NULL PRIMARY KEY,   -- Unifeyed tblcompanies.id
    name                  NVARCHAR(200) NULL,
    eligibility_file_name NVARCHAR(200) NULL,
    status                NVARCHAR(50)  NULL,
    broker                NVARCHAR(100) NULL,
    awp_discount          NVARCHAR(50)  NULL,
    city                  NVARCHAR(100) NULL,
    state                 NVARCHAR(50)  NULL,
    imported_at           DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO

IF OBJECT_ID('dbo.tp_client_pricing','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_client_pricing (
    id                 INT IDENTITY(1,1) PRIMARY KEY,
    source_id          INT           NULL,   -- tblcompany_pricing.id
    company_id         INT           NULL,   -- -> tp_uf_companies.company_id
    product_source_id  INT           NULL,   -- -> tp_products.source_id
    price              DECIMAL(18,2) NULL,
    company_unit_price DECIMAL(18,4) NULL,
    rebate_amount      DECIMAL(18,2) NULL,
    max_annual_rebate  DECIMAL(18,2) NULL,
    ndc_codes          NVARCHAR(100) NULL,
    imported_at        DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE UNIQUE INDEX UX_tp_client_pricing_src ON dbo.tp_client_pricing(source_id) WHERE source_id IS NOT NULL;
  CREATE INDEX IX_tp_client_pricing_co ON dbo.tp_client_pricing(company_id);
END
GO

IF OBJECT_ID('dbo.tp_client_formulary','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_client_formulary (
    company_id    INT           NOT NULL PRIMARY KEY,   -- -> tp_uf_companies.company_id
    products_json NVARCHAR(MAX) NULL,                   -- JSON array of product source ids
    product_count INT           NULL,
    imported_at   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
END
GO
