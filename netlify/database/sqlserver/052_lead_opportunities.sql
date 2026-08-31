-- Sales: lead opportunities that convert into client contracts + benefits.

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tp_lead_opportunities')
BEGIN
  CREATE TABLE dbo.tp_lead_opportunities (
    id INT IDENTITY(1,1) CONSTRAINT PK_tp_lead_opp PRIMARY KEY,
    lead_id INT NOT NULL,
    name NVARCHAR(200) NOT NULL,
    value DECIMAL(18,2) NULL,
    stage VARCHAR(20) NOT NULL CONSTRAINT DF_tp_lead_opp_stage DEFAULT 'Open',  -- Open | Won | Lost
    effective_date DATE NULL, end_date DATE NULL,
    notes NVARCHAR(MAX) NULL,
    converted_contract_id INT NULL,   -- Client_Contracts.id created on lead conversion
    created_by INT NULL,
    created_at DATETIME NOT NULL CONSTRAINT DF_tp_lead_opp_ca DEFAULT GETDATE()
  );
  CREATE INDEX IX_lead_opp_lead ON dbo.tp_lead_opportunities(lead_id);
END;

-- Opportunity benefits mirror Client_Contract_Benefits (type iRx/GLP1, GLP-1 drug $).
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tp_lead_opp_benefits')
BEGIN
  CREATE TABLE dbo.tp_lead_opp_benefits (
    id INT IDENTITY(1,1) CONSTRAINT PK_tp_lead_opp_ben PRIMARY KEY,
    opportunity_id INT NOT NULL,
    name NVARCHAR(200) NOT NULL,
    type NVARCHAR(20) NULL, coverage NVARCHAR(200) NULL, value NVARCHAR(100) NULL,
    notes NVARCHAR(MAX) NULL,
    tirzepatide_amount DECIMAL(18,2) NULL, semaglutide_amount DECIMAL(18,2) NULL,
    created_at DATETIME NOT NULL CONSTRAINT DF_tp_lead_opp_ben_ca DEFAULT GETDATE()
  );
  CREATE INDEX IX_lead_opp_ben_opp ON dbo.tp_lead_opp_benefits(opportunity_id);
END;

-- Claims perf: make IX_ClaimsProd_client cover the Claims-list columns so the parsed-date
-- filter is evaluated from the index (no per-row heap lookup). Without this, large clients
-- (e.g. City of McAllen, ~19.5k claims) timed out the Claims tab to a 500.
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ClaimsProd_client' AND object_id = OBJECT_ID('dbo.ClaimsData_Prod'))
  DROP INDEX IX_ClaimsProd_client ON dbo.ClaimsData_Prod;
CREATE INDEX IX_ClaimsProd_client ON dbo.ClaimsData_Prod(clientid)
  INCLUDE(dateofservice, drugname, patientid, ndc, dayssupply, quantitydispensed,
          pharmacyname, gpi02, planpaid, grosscost, copay, patientlastname, patientfirstname);
