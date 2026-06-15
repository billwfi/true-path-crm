-- ─────────────────────────────────────────────────────────────────────────────
-- GLP1 intake questionnaire, completed by the Client Concierge on the Member
-- Record page. One row per member (same member_key scheme as the contact log /
-- intake record). Answers are stored as a single JSON document so the question
-- set can evolve without schema churn. Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/003_glp1_questionnaire.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.GLP1_Questionnaire', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.GLP1_Questionnaire (
    member_key  NVARCHAR(100) NOT NULL,
    category    NVARCHAR(50)  NOT NULL CONSTRAINT DF_QN_category DEFAULT 'GLP1',
    answers     NVARCHAR(MAX) NULL,            -- JSON document of all answers
    disqualified BIT          NOT NULL CONSTRAINT DF_QN_dq DEFAULT 0,
    updated_by  INT           NULL,
    updated_at  DATETIME      NOT NULL CONSTRAINT DF_QN_updated DEFAULT GETDATE(),
    created_at  DATETIME      NOT NULL CONSTRAINT DF_QN_created DEFAULT GETDATE(),
    CONSTRAINT PK_GLP1_Questionnaire PRIMARY KEY (category, member_key)
  );
END
GO
