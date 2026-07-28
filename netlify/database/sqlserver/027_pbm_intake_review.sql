-- Review workflow for API-submitted member records: verify + assign to a Client Concierge (tp_staff).
IF COL_LENGTH('dbo.PBM_Member_Intake','Status') IS NULL
  ALTER TABLE dbo.PBM_Member_Intake ADD Status NVARCHAR(20) NOT NULL DEFAULT 'New';   -- New | Verified | Assigned | Rejected
GO
IF COL_LENGTH('dbo.PBM_Member_Intake','AssignedConciergeId') IS NULL
  ALTER TABLE dbo.PBM_Member_Intake ADD AssignedConciergeId INT NULL;
GO
IF COL_LENGTH('dbo.PBM_Member_Intake','AssignedConciergeName') IS NULL
  ALTER TABLE dbo.PBM_Member_Intake ADD AssignedConciergeName NVARCHAR(150) NULL;
GO
IF COL_LENGTH('dbo.PBM_Member_Intake','VerifiedBy') IS NULL
  ALTER TABLE dbo.PBM_Member_Intake ADD VerifiedBy INT NULL;
GO
IF COL_LENGTH('dbo.PBM_Member_Intake','VerifiedAt') IS NULL
  ALTER TABLE dbo.PBM_Member_Intake ADD VerifiedAt DATETIME2 NULL;
GO
IF COL_LENGTH('dbo.PBM_Member_Intake','ReviewNotes') IS NULL
  ALTER TABLE dbo.PBM_Member_Intake ADD ReviewNotes NVARCHAR(MAX) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PBM_Intake_status')
  CREATE INDEX IX_PBM_Intake_status ON dbo.PBM_Member_Intake (Status, ReceivedAt);
GO
