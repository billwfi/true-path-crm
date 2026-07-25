-- ─────────────────────────────────────────────────────────────────────────────
-- Marketing email: templates, campaigns, and per-recipient delivery tracking
-- (ACS Email + Event Grid delivery/bounce/open reports).
--   node scripts/run-sql.js netlify/database/sqlserver/023_email_campaigns.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.Email_Templates','U') IS NULL
BEGIN
  CREATE TABLE dbo.Email_Templates (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    tkey       NVARCHAR(60)  NOT NULL UNIQUE,   -- e.g. rebrand-en
    name       NVARCHAR(150) NOT NULL,
    language   NVARCHAR(5)   NOT NULL,          -- en | es
    subject    NVARCHAR(300) NOT NULL,
    html_body  NVARCHAR(MAX) NOT NULL,
    updated_by INT           NULL,
    updated_at DATETIME      NULL,
    created_at DATETIME      NOT NULL CONSTRAINT DF_ET_created DEFAULT GETDATE()
  );
END
GO

IF OBJECT_ID('dbo.Email_Campaigns','U') IS NULL
BEGIN
  CREATE TABLE dbo.Email_Campaigns (
    id           INT IDENTITY(1,1) PRIMARY KEY,
    name         NVARCHAR(200) NOT NULL,
    status       NVARCHAR(20)  NOT NULL CONSTRAINT DF_EC_status DEFAULT 'Draft', -- Draft|Sending|Paused|Sent
    from_address NVARCHAR(200) NOT NULL CONSTRAINT DF_EC_from DEFAULT 'noreply@truepathsourcing.com',
    template_en  NVARCHAR(60)  NULL,
    template_es  NVARCHAR(60)  NULL,
    default_lang NVARCHAR(5)   NOT NULL CONSTRAINT DF_EC_lang DEFAULT 'en',
    daily_cap    INT           NOT NULL CONSTRAINT DF_EC_cap DEFAULT 400,        -- send pacing
    created_by   INT           NULL,
    created_at   DATETIME      NOT NULL CONSTRAINT DF_EC_created DEFAULT GETDATE(),
    sent_at      DATETIME      NULL
  );
END
GO

IF OBJECT_ID('dbo.Email_Campaign_Recipients','U') IS NULL
BEGIN
  CREATE TABLE dbo.Email_Campaign_Recipients (
    id           INT IDENTITY(1,1) PRIMARY KEY,
    campaign_id  INT           NOT NULL,
    company_name NVARCHAR(200) NULL,
    first_name   NVARCHAR(100) NULL,
    last_name    NVARCHAR(100) NULL,
    email        NVARCHAR(200) NOT NULL,
    language     NVARCHAR(5)   NULL,
    status       NVARCHAR(20)  NOT NULL CONSTRAINT DF_ECR_status DEFAULT 'Pending', -- Pending|Sent|Delivered|Bounced|Failed|Suppressed|Opened
    message_id   NVARCHAR(120) NULL,
    error        NVARCHAR(400) NULL,
    sent_at      DATETIME      NULL,
    delivered_at DATETIME      NULL,
    opened_at    DATETIME      NULL,
    bounced_at   DATETIME      NULL
  );
  CREATE INDEX IX_ECR_campaign ON dbo.Email_Campaign_Recipients(campaign_id, status);
  CREATE INDEX IX_ECR_msg ON dbo.Email_Campaign_Recipients(message_id);
END
GO
