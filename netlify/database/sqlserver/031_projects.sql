-- Promote "projects" to a first-class top level above milestones/tasks.
--   Projects (new) → Project_Categories (milestones/sections) → Project_Tasks → sub-tasks
-- The old text `plan` becomes a real Projects row. Seed the 4 projects, link the
-- existing milestones/categories to them, and turn the two placeholder categories
-- (Liviniti APIs, Bookings Calendar Migrations) into their own projects. Idempotent.

IF OBJECT_ID('dbo.Projects','U') IS NULL
CREATE TABLE dbo.Projects (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  name        NVARCHAR(200) NOT NULL,
  description NVARCHAR(MAX) NULL,
  lead        NVARCHAR(120) NULL,
  dev_lead    NVARCHAR(120) NULL,
  priority    NVARCHAR(20) NULL,       -- Low / Medium / High
  status      NVARCHAR(30) NULL,       -- optional explicit override; else derived
  start_date  DATE NULL,
  end_date    DATE NULL,
  sort_order  INT NOT NULL DEFAULT 100,
  created_at  DATETIME NOT NULL DEFAULT GETDATE()
);
GO
IF COL_LENGTH('dbo.Project_Categories','project_id') IS NULL
  ALTER TABLE dbo.Project_Categories ADD project_id INT NULL;
GO

-- Seed / update the 4 projects (idempotent by name).
MERGE dbo.Projects AS tgt
USING (SELECT * FROM (VALUES
    ('CRM Migration',                'High',   '2026-08-01', '2026-10-29', 1),
    ('New Development',              'Medium', NULL,         NULL,         2),
    ('Liviniti APIs',                'Medium', '2026-07-15', '2026-09-04', 3),
    ('Bookings Calendar Migrations', 'Medium', '2026-07-01', '2026-08-14', 4)
  ) x(name, priority, sd, ed, sort_order)) AS src
   ON tgt.name = src.name
 WHEN MATCHED THEN UPDATE SET priority=src.priority, start_date=CAST(src.sd AS DATE),
      end_date=CAST(src.ed AS DATE), sort_order=src.sort_order
 WHEN NOT MATCHED THEN INSERT (name, priority, start_date, end_date, sort_order)
      VALUES (src.name, src.priority, CAST(src.sd AS DATE), CAST(src.ed AS DATE), src.sort_order);
GO

-- Link existing milestones/categories to their project.
DECLARE @crm INT = (SELECT id FROM dbo.Projects WHERE name='CRM Migration');
DECLARE @nd  INT = (SELECT id FROM dbo.Projects WHERE name='New Development');
UPDATE dbo.Project_Categories SET project_id=@crm WHERE [plan]='CRM Migration';
UPDATE dbo.Project_Categories SET project_id=@nd
  WHERE [plan]='New Development' AND title NOT IN ('Liviniti APIs','Bookings Calendar Migrations');

-- Drop the two placeholder categories (their metadata now lives on the Projects rows);
-- only if empty of tasks.
DELETE FROM dbo.Project_Categories
 WHERE [plan]='New Development' AND title IN ('Liviniti APIs','Bookings Calendar Migrations')
   AND NOT EXISTS (SELECT 1 FROM dbo.Project_Tasks t WHERE t.category_id = dbo.Project_Categories.id);

-- Give the two new projects a starter milestone so tasks can be added immediately.
DECLARE @liv INT = (SELECT id FROM dbo.Projects WHERE name='Liviniti APIs');
DECLARE @bok INT = (SELECT id FROM dbo.Projects WHERE name='Bookings Calendar Migrations');
IF @liv IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.Project_Categories WHERE project_id=@liv)
  INSERT INTO dbo.Project_Categories (code,title,goal,sort_order,[plan],project_id) VALUES ('','General',NULL,1,'Liviniti APIs',@liv);
IF @bok IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.Project_Categories WHERE project_id=@bok)
  INSERT INTO dbo.Project_Categories (code,title,goal,sort_order,[plan],project_id) VALUES ('','General',NULL,1,'Bookings Calendar Migrations',@bok);
GO
