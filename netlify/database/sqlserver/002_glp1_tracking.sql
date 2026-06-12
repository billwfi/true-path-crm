-- ─────────────────────────────────────────────────────────────────────────────
-- GLP1 intake workflow for ASSIGNED members.
-- Keyed by member_key = COALESCE(NULLIF(Member_ID,''), CAST(indx AS VARCHAR(50)))
-- so all of a member's claims share one contact log and one intake record
-- (assignment is member-level). Run with: node scripts/run-sql.js <this file>
-- ─────────────────────────────────────────────────────────────────────────────

-- Contact attempts logged by the Client Concierge.
IF OBJECT_ID('dbo.GLP1_ContactLog', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.GLP1_ContactLog (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    member_key     NVARCHAR(100) NOT NULL,
    category       NVARCHAR(50)  NOT NULL CONSTRAINT DF_CL_category DEFAULT 'GLP1',
    contact_date   DATE          NOT NULL,
    contact_type   NVARCHAR(20)  NOT NULL,        -- Phone Call | Text | Email | Other
    notes          NVARCHAR(MAX) NULL,
    followup_date  DATE          NULL,
    contact_status NVARCHAR(10)  NOT NULL CONSTRAINT DF_CL_status DEFAULT 'Open',  -- Open | Closed
    created_by     INT           NULL,            -- tp_staff / dbo.Users id
    created_at     DATETIME      NOT NULL CONSTRAINT DF_CL_created DEFAULT GETDATE()
  );
  CREATE INDEX IX_GLP1_ContactLog_member ON dbo.GLP1_ContactLog(category, member_key);
END
GO

-- One intake record per member, auto-created when the member is assigned.
IF OBJECT_ID('dbo.GLP1_Intake', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.GLP1_Intake (
    member_key  NVARCHAR(100) NOT NULL,
    category    NVARCHAR(50)  NOT NULL CONSTRAINT DF_IN_category DEFAULT 'GLP1',
    -- In Progress | Outreach Completed | Submitted to WellSync
    status      NVARCHAR(50)  NOT NULL CONSTRAINT DF_IN_status DEFAULT 'In Progress',
    status_date DATE          NULL,
    -- Only for status 'Submitted to WellSync': Declined Enrollment | Approved | Clinical Denial
    sub_status  NVARCHAR(50)  NULL,
    updated_by  INT           NULL,
    updated_at  DATETIME      NOT NULL CONSTRAINT DF_IN_updated DEFAULT GETDATE(),
    created_at  DATETIME      NOT NULL CONSTRAINT DF_IN_created DEFAULT GETDATE(),
    CONSTRAINT PK_GLP1_Intake PRIMARY KEY (category, member_key)
  );
END
GO
