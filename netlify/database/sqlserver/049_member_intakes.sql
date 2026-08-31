-- ─────────────────────────────────────────────────────────────────────────────
-- Client Concierge intake engine — unified Intake Status record.
-- One row per (member, intake_type), so a member can hold MULTIPLE intake status
-- records — GLP1 and/or non-GLP1 — worked independently. The GLP1 questionnaire is
-- folded IN as part of the intake status record (questionnaire + disqualified columns),
-- replacing the separate GLP1_Questionnaire table. intake_type matches tp_intake_types.code.
--
-- Data is migrated from GLP1_Intake + GLP1_Questionnaire by scripts.
-- Run with: node scripts/run-sql.js netlify/database/sqlserver/049_member_intakes.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.tp_member_intakes','U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_member_intakes (
    member_key    NVARCHAR(50)  NOT NULL,
    intake_type   NVARCHAR(20)  NOT NULL,   -- -> tp_intake_types.code (GLP1 / NONGLP1 / …)
    status        NVARCHAR(50)  NULL,
    sub_status    NVARCHAR(50)  NULL,
    status_date   DATE          NULL,
    questionnaire NVARCHAR(MAX) NULL,        -- JSON answers (folded in from GLP1_Questionnaire)
    disqualified  BIT           NOT NULL DEFAULT 0,
    updated_by    INT           NULL,
    updated_at    DATETIME2     NULL,
    created_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_tp_member_intakes PRIMARY KEY (member_key, intake_type)
  );
END
GO
