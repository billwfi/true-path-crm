-- ─────────────────────────────────────────────────────────────────────────────
-- Client Concierge intake engine — Phase 1 Stage 1: intake-type taxonomy.
-- Defines each intake type (GLP1 or non-GLP1) and its status lifecycle, so the
-- assignment/intake flow is type-driven instead of hardcoded to GLP1. The `code`
-- matches the `category` column already used on ReadyToAssign / GLP1_Intake /
-- GLP1_ContactLog / GLP1_Questionnaire.
--
-- Run with: node scripts/run-sql.js netlify/database/sqlserver/048_intake_types.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.tp_intake_types','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_intake_types (
    code          NVARCHAR(20)  NOT NULL PRIMARY KEY,   -- matches ReadyToAssign.category
    name          NVARCHAR(80)  NOT NULL,
    description   NVARCHAR(500) NULL,
    statuses      NVARCHAR(MAX) NULL,   -- JSON array: the intake status lifecycle
    sub_statuses  NVARCHAR(MAX) NULL,   -- JSON object: status -> [sub-statuses]
    color         NVARCHAR(20)  NULL,   -- badge color hint
    is_glp1       BIT           NOT NULL DEFAULT 0,
    active        BIT           NOT NULL DEFAULT 1,
    sort_order    INT           NOT NULL DEFAULT 100,
    created_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at    DATETIME2     NULL
  );
END
GO
