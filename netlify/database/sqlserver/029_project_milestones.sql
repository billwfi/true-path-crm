-- CRM Migration → a real PM hierarchy: Milestone → Task → Sub-task (+ attachments).
--   Milestones reuse Project_Categories (add start_date/end_date; goal = "focus").
--   Tasks/sub-tasks reuse Project_Tasks (add due_date, parent_task_id, assignee).
--   Attachments live in a new table, hung off any task/sub-task.
-- Idempotent — safe to re-run.

-- 1) New columns ---------------------------------------------------------------
IF COL_LENGTH('dbo.Project_Categories','start_date') IS NULL
  ALTER TABLE dbo.Project_Categories ADD start_date DATE NULL;
GO
IF COL_LENGTH('dbo.Project_Categories','end_date') IS NULL
  ALTER TABLE dbo.Project_Categories ADD end_date DATE NULL;
GO
IF COL_LENGTH('dbo.Project_Tasks','due_date') IS NULL
  ALTER TABLE dbo.Project_Tasks ADD due_date DATE NULL;
GO
IF COL_LENGTH('dbo.Project_Tasks','parent_task_id') IS NULL
  ALTER TABLE dbo.Project_Tasks ADD parent_task_id INT NULL;
GO
IF COL_LENGTH('dbo.Project_Tasks','assignee') IS NULL
  ALTER TABLE dbo.Project_Tasks ADD assignee NVARCHAR(120) NULL;
GO

-- 2) Attachments ---------------------------------------------------------------
IF OBJECT_ID('dbo.Project_Task_Attachments','U') IS NULL
CREATE TABLE dbo.Project_Task_Attachments (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  task_id      INT NOT NULL,
  filename     NVARCHAR(260) NOT NULL,
  content_type NVARCHAR(120) NULL,
  size_bytes   INT NULL,
  data_b64     NVARCHAR(MAX) NULL,          -- base64 payload (small docs)
  uploaded_by  INT NULL,
  uploaded_at  DATETIME NOT NULL DEFAULT GETDATE()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PTA_task' AND object_id=OBJECT_ID('dbo.Project_Task_Attachments'))
  CREATE INDEX IX_PTA_task ON dbo.Project_Task_Attachments(task_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_PT_parent' AND object_id=OBJECT_ID('dbo.Project_Tasks'))
  CREATE INDEX IX_PT_parent ON dbo.Project_Tasks(parent_task_id);
GO

-- 3) Seed the 9 CRM Build milestones (Aug 1 – Oct 29, 2026) --------------------
;WITH m(title, goal, start_date, end_date, sort_order) AS (
  SELECT * FROM (VALUES
    ('Discovery & Requirements',       'Document workflows, interview stakeholders, define must-haves.',                         '2026-08-01','2026-08-15',201),
    ('Data Assessment & Mapping',      'Inventory clients, contracts, prescription cost & savings data; map fields.',            '2026-08-10','2026-08-25',202),
    ('Implementation Planning',        'Architecture, modules, permissions, migration & go-live criteria.',                      '2026-08-20','2026-08-30',203),
    ('Configuration & Buildout',       'Build clients, contracts, cost tracking, dashboards & automations.',                     '2026-08-31','2026-09-19',204),
    ('Data Cleanup & Test Migration',  'Dedupe, standardize, run test migration, validate counts & mappings.',                   '2026-09-09','2026-09-29',205),
    ('User Acceptance Testing (UAT)',  'Pilot core workflows, collect defects, confirm go-live readiness.',                      '2026-09-19','2026-09-29',206),
    ('Production Migration & GO-LIVE', 'Cutover, final data import, switch users, CRM becomes system of record.',                '2026-09-30','2026-10-14',207),
    ('Training & Adoption',            'Role-based training, quick guides, super users, support process.',                       '2026-10-04','2026-10-24',208),
    ('Stabilization & Optimization',   'Resolve defects, tune reports, verify leadership reporting, phase 2 backlog.',           '2026-10-14','2026-10-29',209)
  ) x(title, goal, start_date, end_date, sort_order)
)
MERGE dbo.Project_Categories AS tgt
USING (SELECT title, goal, CAST(start_date AS DATE) start_date, CAST(end_date AS DATE) end_date, sort_order FROM m) AS src
   ON tgt.[plan]='CRM Migration' AND tgt.title=src.title
 WHEN MATCHED THEN UPDATE SET goal=src.goal, start_date=src.start_date, end_date=src.end_date, sort_order=src.sort_order
 WHEN NOT MATCHED THEN
   INSERT (code, title, goal, sort_order, [plan], start_date, end_date)
   VALUES ('', src.title, src.goal, src.sort_order, 'CRM Migration', src.start_date, src.end_date);
GO

-- 4) Move the 21 module categories under "Configuration & Buildout" as tasks ---
DECLARE @cb INT = (SELECT id FROM dbo.Project_Categories WHERE [plan]='CRM Migration' AND title='Configuration & Buildout');
DECLARE @milestones TABLE (title NVARCHAR(200));
INSERT INTO @milestones VALUES
  ('Discovery & Requirements'),('Data Assessment & Mapping'),('Implementation Planning'),
  ('Configuration & Buildout'),('Data Cleanup & Test Migration'),('User Acceptance Testing (UAT)'),
  ('Production Migration & GO-LIVE'),('Training & Adoption'),('Stabilization & Optimization');

INSERT INTO dbo.Project_Tasks (category_id, title, description, sort_order, status, updated_at)
SELECT @cb, c.title, c.goal, c.sort_order, 'Not Started', GETDATE()
  FROM dbo.Project_Categories c
 WHERE c.[plan]='CRM Migration'
   AND c.title NOT IN (SELECT title FROM @milestones)
   AND NOT EXISTS (SELECT 1 FROM dbo.Project_Tasks t WHERE t.category_id=@cb AND t.title=c.title AND t.parent_task_id IS NULL);

DELETE FROM dbo.Project_Categories
 WHERE [plan]='CRM Migration' AND title NOT IN (SELECT title FROM @milestones);
GO
