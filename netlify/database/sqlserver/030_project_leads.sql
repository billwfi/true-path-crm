-- Project (milestone/category) lead + dev lead, shown on the PM Dashboard's
-- Project Progress table. Nullable free text. Idempotent.
IF COL_LENGTH('dbo.Project_Categories','lead') IS NULL
  ALTER TABLE dbo.Project_Categories ADD lead NVARCHAR(120) NULL;
GO
IF COL_LENGTH('dbo.Project_Categories','dev_lead') IS NULL
  ALTER TABLE dbo.Project_Categories ADD dev_lead NVARCHAR(120) NULL;
GO
