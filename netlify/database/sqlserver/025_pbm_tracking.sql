-- PBM Tracking: PBMs (like clients) + contacts/contracts/benefits + groups + member intake.
-- A "PBM" (e.g. Liviniti) manages benefit groups (GroupID) for employer clients (ClientID).
-- Sub-tables carry an indexed pbm_id / contract_id INT (logical FK, same convention as Client_*).

-- ── Main entity ───────────────────────────────────────────────────────────────
IF OBJECT_ID('dbo.tp_pbms','U') IS NULL
CREATE TABLE dbo.tp_pbms (
  id                  INT IDENTITY(1,1) PRIMARY KEY,
  name                NVARCHAR(200) NOT NULL,
  pbm_code            NVARCHAR(50)  NULL,          -- short code, e.g. LIVINITI
  carrier             NVARCHAR(50)  NULL,          -- eligibility CARRIER link (optional)
  email               NVARCHAR(200) NULL,
  phone               NVARCHAR(50)  NULL,
  website             NVARCHAR(200) NULL,
  sftp_host           NVARCHAR(200) NULL,          -- feed host, e.g. sftp.liviniti.com
  address             NVARCHAR(200) NULL,
  city                NVARCHAR(100) NULL,
  state               NVARCHAR(50)  NULL,
  zip_code            NVARCHAR(20)  NULL,
  account_coordinator NVARCHAR(150) NULL,
  notes               NVARCHAR(MAX) NULL,
  active              BIT NOT NULL DEFAULT 1,
  created_by          INT NULL,
  created_at          DATETIME NOT NULL DEFAULT GETDATE(),
  updated_at          DATETIME NULL
);
GO

-- ── Contacts ──────────────────────────────────────────────────────────────────
IF OBJECT_ID('dbo.PBM_Contacts','U') IS NULL
CREATE TABLE dbo.PBM_Contacts (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  pbm_id     INT NOT NULL,
  name       NVARCHAR(150) NOT NULL,
  title      NVARCHAR(150) NULL,
  email      NVARCHAR(200) NULL,
  phone      NVARCHAR(50)  NULL,
  notes      NVARCHAR(MAX) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT GETDATE()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PBM_Contacts_pbm')
  CREATE INDEX IX_PBM_Contacts_pbm ON dbo.PBM_Contacts (pbm_id);
GO

-- ── Contracts ─────────────────────────────────────────────────────────────────
IF OBJECT_ID('dbo.PBM_Contracts','U') IS NULL
CREATE TABLE dbo.PBM_Contracts (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  pbm_id          INT NOT NULL,
  name            NVARCHAR(200) NOT NULL,
  contract_number NVARCHAR(100) NULL,
  effective_date  DATE NULL,
  end_date        DATE NULL,
  status          NVARCHAR(30) NOT NULL DEFAULT 'Active',
  notes           NVARCHAR(MAX) NULL,
  created_by      INT NULL,
  created_at      DATETIME NOT NULL DEFAULT GETDATE(),
  updated_at      DATETIME NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PBM_Contracts_pbm')
  CREATE INDEX IX_PBM_Contracts_pbm ON dbo.PBM_Contracts (pbm_id);
GO

-- ── Contract benefits ─────────────────────────────────────────────────────────
IF OBJECT_ID('dbo.PBM_Contract_Benefits','U') IS NULL
CREATE TABLE dbo.PBM_Contract_Benefits (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  contract_id INT NOT NULL,
  name        NVARCHAR(200) NOT NULL,
  type        NVARCHAR(50)  NULL,
  coverage    NVARCHAR(200) NULL,
  value       NVARCHAR(200) NULL,
  notes       NVARCHAR(MAX) NULL,
  created_at  DATETIME NOT NULL DEFAULT GETDATE()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PBM_Benefits_contract')
  CREATE INDEX IX_PBM_Benefits_contract ON dbo.PBM_Contract_Benefits (contract_id);
GO

-- ── Groups (benefit groups within a PBM; keyed on GroupID) ─────────────────────
IF OBJECT_ID('dbo.PBM_Groups','U') IS NULL
CREATE TABLE dbo.PBM_Groups (
  id             INT IDENTITY(1,1) PRIMARY KEY,
  pbm_id         INT NOT NULL,
  group_code     NVARCHAR(100) NOT NULL,           -- GroupID (eligibility join key)
  group_name     NVARCHAR(200) NULL,
  client_code    NVARCHAR(1000) NULL,              -- ClientID (parent employer; can be a pipe-delimited list)
  company_name   NVARCHAR(200) NULL,
  status         NVARCHAR(30) NOT NULL DEFAULT 'Active',
  effective_date DATE NULL,
  notes          NVARCHAR(MAX) NULL,
  created_by     INT NULL,
  created_at     DATETIME NOT NULL DEFAULT GETDATE(),
  updated_at     DATETIME NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PBM_Groups_pbm')
  CREATE INDEX IX_PBM_Groups_pbm ON dbo.PBM_Groups (pbm_id, group_code);
GO

-- ── Member intake (API-posted new members; accumulates, NOT truncated) ────────
IF OBJECT_ID('dbo.PBM_Member_Intake','U') IS NULL
CREATE TABLE dbo.PBM_Member_Intake (
  id BIGINT IDENTITY(1,1) PRIMARY KEY,
  pbm_id INT NULL,
  CardholderID NVARCHAR(4000) NULL, PersonCode NVARCHAR(4000) NULL, Relationship NVARCHAR(4000) NULL,
  LastName NVARCHAR(4000) NULL, FirstName NVARCHAR(4000) NULL, MiddleName NVARCHAR(4000) NULL,
  Suffix NVARCHAR(4000) NULL, Gender NVARCHAR(4000) NULL, DateOfBirth NVARCHAR(4000) NULL,
  CardholderSSN NVARCHAR(4000) NULL, MemberSSN NVARCHAR(4000) NULL, ExternalID NVARCHAR(4000) NULL,
  Address1 NVARCHAR(4000) NULL, Address2 NVARCHAR(4000) NULL, City NVARCHAR(4000) NULL,
  State NVARCHAR(4000) NULL, Zip NVARCHAR(4000) NULL, HomePhone NVARCHAR(4000) NULL,
  EmailAddress NVARCHAR(4000) NULL, GroupID NVARCHAR(4000) NULL, ARType NVARCHAR(4000) NULL,
  EffectiveStart NVARCHAR(4000) NULL, EffectiveEnd NVARCHAR(4000) NULL, PlanName NVARCHAR(4000) NULL,
  EmployeeStatusCode NVARCHAR(4000) NULL, EmployeeStatus NVARCHAR(4000) NULL, EmployeeStatusDetail NVARCHAR(4000) NULL,
  SecondaryCoverageOnly NVARCHAR(4000) NULL, Active NVARCHAR(4000) NULL, ClientID NVARCHAR(4000) NULL,
  GroupName NVARCHAR(4000) NULL, NewTechID NVARCHAR(4000) NULL, EmployeeStatusEffectiveStart NVARCHAR(4000) NULL,
  EmployeeLocationCode NVARCHAR(4000) NULL, EmployeeLocation NVARCHAR(4000) NULL, EmployeeLocationDetail NVARCHAR(4000) NULL,
  EmployeeLocationEffectiveStart NVARCHAR(4000) NULL, CoverageLevelCode NVARCHAR(4000) NULL, AlternateID NVARCHAR(4000) NULL,
  OtherStatusCode NVARCHAR(4000) NULL, OtherStatus NVARCHAR(4000) NULL, OtherStatusDetail NVARCHAR(4000) NULL,
  OtherStatusEffectiveStart NVARCHAR(4000) NULL, CreatedOn NVARCHAR(4000) NULL, ChangedOn NVARCHAR(4000) NULL,
  Source NVARCHAR(20) NOT NULL DEFAULT 'api',
  RawJson NVARCHAR(MAX) NULL,
  ReceivedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PBM_Intake_group')
  CREATE INDEX IX_PBM_Intake_group ON dbo.PBM_Member_Intake (pbm_id, GroupID);
GO

-- ── Seed the Liviniti PBM ─────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM dbo.tp_pbms WHERE pbm_code='LIVINITI')
  INSERT INTO dbo.tp_pbms (name, pbm_code, sftp_host, notes, active)
  VALUES ('Liviniti (RxCompass)', 'LIVINITI', 'sftp.liviniti.com',
          'Weekly RxCompass eligibility feed → dbo.Eligibility_Liviniti (Mon 7am CT). API intake → dbo.PBM_Member_Intake.', 1);
GO
