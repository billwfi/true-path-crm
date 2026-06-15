-- ─────────────────────────────────────────────────────────────────────────────
-- Client detail: contacts, contracts, and per-contract benefits.
-- Keyed by client_id = tp_clients.id (Postgres). No cross-DB FK is enforced
-- (same convention the GLP1 tables use with member_key). Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/004_client_detail.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- People associated with a client (multiple per client).
IF OBJECT_ID('dbo.Client_Contacts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Client_Contacts (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    client_id  INT           NOT NULL,
    name       NVARCHAR(200) NOT NULL,
    title      NVARCHAR(150) NULL,
    email      NVARCHAR(200) NULL,
    phone      NVARCHAR(50)  NULL,
    notes      NVARCHAR(MAX) NULL,
    created_by INT           NULL,
    created_at DATETIME      NOT NULL CONSTRAINT DF_CC_created DEFAULT GETDATE()
  );
  CREATE INDEX IX_Client_Contacts_client ON dbo.Client_Contacts(client_id);
END
GO

-- Contracts held by a client (one or more).
IF OBJECT_ID('dbo.Client_Contracts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Client_Contracts (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    client_id       INT           NOT NULL,
    name            NVARCHAR(200) NOT NULL,
    contract_number NVARCHAR(100) NULL,
    effective_date  DATE          NULL,
    end_date        DATE          NULL,
    -- Active | Pending | Expired | Cancelled
    status          NVARCHAR(30)  NOT NULL CONSTRAINT DF_CT_status DEFAULT 'Active',
    notes           NVARCHAR(MAX) NULL,
    created_by      INT           NULL,
    created_at      DATETIME      NOT NULL CONSTRAINT DF_CT_created DEFAULT GETDATE(),
    updated_at      DATETIME      NOT NULL CONSTRAINT DF_CT_updated DEFAULT GETDATE()
  );
  CREATE INDEX IX_Client_Contracts_client ON dbo.Client_Contracts(client_id);
END
GO

-- Benefits attached to a contract (one or more per contract).
IF OBJECT_ID('dbo.Client_Contract_Benefits', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Client_Contract_Benefits (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    contract_id INT           NOT NULL,
    name        NVARCHAR(200) NOT NULL,
    type        NVARCHAR(100) NULL,
    coverage    NVARCHAR(MAX) NULL,
    value       NVARCHAR(100) NULL,
    notes       NVARCHAR(MAX) NULL,
    created_at  DATETIME      NOT NULL CONSTRAINT DF_CB_created DEFAULT GETDATE()
  );
  CREATE INDEX IX_Client_Contract_Benefits_contract ON dbo.Client_Contract_Benefits(contract_id);
END
GO
