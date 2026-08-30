-- ─────────────────────────────────────────────────────────────────────────────
-- Procurement › Product Master & Vendors. Foundational masters migrated from the
-- Unifeyed database (tblproducts / tblproduct_ndc_codes). A product carries NDC,
-- strength, unit-of-measure (unit_type + unit_quantity), pricing, AWP, vendor, and
-- specialty flags — so Client Concierge can put a real medication on a procurement
-- ticket and Procurement/Finance get pricing & UOM.
--
-- Loaded by scripts/procurement/import_products.py (cross-database MERGE).
-- Run with: node scripts/run-sql.js netlify/database/sqlserver/045_product_master.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.tp_vendors','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_vendors (
    id     INT           NOT NULL PRIMARY KEY,   -- matches Unifeyed tblproducts.vendor
    name   NVARCHAR(100) NOT NULL,
    active BIT           NOT NULL DEFAULT 1
  );
END
GO

IF OBJECT_ID('dbo.tp_products','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_products (
    id               INT IDENTITY(1,1) PRIMARY KEY,
    source_id        INT           NULL,          -- Unifeyed tblproducts.id
    label            NVARCHAR(300) NULL,
    short_name       NVARCHAR(150) NULL,
    strength         NVARCHAR(100) NULL,
    ndc              NVARCHAR(20)  NULL,
    ndc_comp         NVARCHAR(20)  NULL,
    unit_type        NVARCHAR(60)  NULL,          -- unit of measure (tabs/capsules, mL, etc.)
    unit_quantity    DECIMAL(18,4) NULL,
    unit_price       DECIMAL(18,4) NULL,
    unit_cost        DECIMAL(18,4) NULL,
    price            DECIMAL(18,2) NULL,
    cost             DECIMAL(18,2) NULL,
    awp              DECIMAL(18,4) NULL,
    vendor_id        INT           NULL,
    drug_class       NVARCHAR(60)  NULL,
    specialty        BIT           NOT NULL DEFAULT 0,
    high_maintenance BIT           NOT NULL DEFAULT 0,
    country          NVARCHAR(60)  NULL,
    source_status    INT           NULL,
    active           BIT           NOT NULL DEFAULT 1,
    uba_id           BIGINT        NULL,
    monarch_id       BIGINT        NULL,
    imported_at      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at       DATETIME2     NULL
  );
  CREATE UNIQUE INDEX UX_tp_products_source ON dbo.tp_products(source_id) WHERE source_id IS NOT NULL;
  CREATE INDEX IX_tp_products_ndc ON dbo.tp_products(ndc);
  CREATE INDEX IX_tp_products_short ON dbo.tp_products(short_name);
END
GO

IF OBJECT_ID('dbo.tp_product_ndc','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_product_ndc (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    product_source_id INT           NULL,          -- Unifeyed tblproduct_ndc_codes.product_id
    ndc_code          NVARCHAR(40)  NULL
  );
  CREATE INDEX IX_tp_product_ndc_prod ON dbo.tp_product_ndc(product_source_id);
END
GO
