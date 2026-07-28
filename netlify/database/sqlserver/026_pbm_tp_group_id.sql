-- Internal "TP Group ID" for PBM groups: TP + incrementing number starting at 1001.
-- Liviniti references this in the intake API instead of raw eligibility GroupIDs.

-- Sequence generates the numeric part (1001, 1002, ...).
IF NOT EXISTS (SELECT 1 FROM sys.sequences WHERE name='PBM_TP_Group_Seq' AND SCHEMA_NAME(schema_id)='dbo')
  CREATE SEQUENCE dbo.PBM_TP_Group_Seq AS INT START WITH 1001 INCREMENT BY 1;
GO

IF COL_LENGTH('dbo.PBM_Groups','tp_group_id') IS NULL
  ALTER TABLE dbo.PBM_Groups ADD tp_group_id NVARCHAR(20) NULL;
GO

IF COL_LENGTH('dbo.PBM_Member_Intake','TPGroupID') IS NULL
  ALTER TABLE dbo.PBM_Member_Intake ADD TPGroupID NVARCHAR(20) NULL;
GO

-- Backfill existing groups deterministically: TP1001.. by id order.
;WITH ordered AS (
  SELECT id, 'TP' + CAST(1000 + ROW_NUMBER() OVER (ORDER BY id) AS varchar(10)) AS newid
  FROM dbo.PBM_Groups WHERE tp_group_id IS NULL
)
UPDATE g SET g.tp_group_id = o.newid
FROM dbo.PBM_Groups g JOIN ordered o ON g.id = o.id;
GO

-- Advance the sequence past the highest backfilled number so new groups continue.
DECLARE @next INT = (SELECT ISNULL(MAX(TRY_CAST(SUBSTRING(tp_group_id,3,20) AS INT)), 1000) + 1
                     FROM dbo.PBM_Groups WHERE tp_group_id LIKE 'TP%');
DECLARE @sql NVARCHAR(200) = N'ALTER SEQUENCE dbo.PBM_TP_Group_Seq RESTART WITH ' + CAST(@next AS NVARCHAR(10));
EXEC sp_executesql @sql;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_PBM_Groups_tpid')
  CREATE UNIQUE INDEX UX_PBM_Groups_tpid ON dbo.PBM_Groups (tp_group_id) WHERE tp_group_id IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PBM_Intake_tpid')
  CREATE INDEX IX_PBM_Intake_tpid ON dbo.PBM_Member_Intake (TPGroupID);
GO
