-- Sales: lead -> client conversion tracking + a lead contact-effort log.

-- Conversion link on the lead.
IF COL_LENGTH('dbo.tp_leads', 'converted_client_id') IS NULL
  ALTER TABLE dbo.tp_leads ADD converted_client_id INT NULL, converted_at DATETIME NULL;

-- Contact efforts against a lead (Email / Phone / Meeting / Other) with follow-up dates.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tp_lead_contacts')
BEGIN
  CREATE TABLE dbo.tp_lead_contacts (
    id            INT IDENTITY(1,1) CONSTRAINT PK_tp_lead_contacts PRIMARY KEY,
    lead_id       INT NOT NULL,
    contact_type  VARCHAR(20) NOT NULL,   -- Email | Phone | Meeting | Other
    contact_date  DATE NULL,
    followup_date DATE NULL,
    notes         NVARCHAR(MAX) NULL,
    created_by    INT NULL,
    created_at    DATETIME NOT NULL CONSTRAINT DF_tp_lead_contacts_ca DEFAULT GETDATE()
  );
  CREATE INDEX IX_lead_contacts_lead ON dbo.tp_lead_contacts(lead_id);
END;
