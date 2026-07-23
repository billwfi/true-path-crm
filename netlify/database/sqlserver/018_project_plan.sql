-- ─────────────────────────────────────────────────────────────────────────────
-- Project Plan: development tracking for the CRM roadmap.
-- Categories = shippable increments; tasks = the individual work items, each
-- with a status and free-text dev notes. Seeded once from the published roadmap.
--   node scripts/run-sql.js netlify/database/sqlserver/018_project_plan.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.Project_Categories', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Project_Categories (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    code       NVARCHAR(8)   NOT NULL,
    title      NVARCHAR(200) NOT NULL,
    goal       NVARCHAR(400) NULL,
    sort_order INT           NOT NULL CONSTRAINT DF_PC_sort DEFAULT 0,
    created_at DATETIME      NOT NULL CONSTRAINT DF_PC_created DEFAULT GETDATE()
  );
END
GO

IF OBJECT_ID('dbo.Project_Tasks', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Project_Tasks (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    category_id INT           NOT NULL,
    title       NVARCHAR(300) NOT NULL,
    description NVARCHAR(MAX) NULL,
    ref_tag     NVARCHAR(20)  NULL,          -- wishlist #n / workflow W1-3
    effort      NVARCHAR(10)  NULL,          -- S / M / L
    status      NVARCHAR(20)  NOT NULL CONSTRAINT DF_PT_status DEFAULT 'Not Started',
    dev_notes   NVARCHAR(MAX) NULL,
    source      NVARCHAR(20)  NOT NULL CONSTRAINT DF_PT_source DEFAULT 'roadmap',  -- roadmap | feedback
    page_url    NVARCHAR(500) NULL,          -- feedback: page the user was on
    screenshot  NVARCHAR(MAX) NULL,          -- feedback: base64 PNG data URL
    sort_order  INT           NOT NULL CONSTRAINT DF_PT_sort DEFAULT 0,
    updated_by  INT           NULL,
    updated_at  DATETIME      NULL,
    created_at  DATETIME      NOT NULL CONSTRAINT DF_PT_created DEFAULT GETDATE()
  );
  CREATE INDEX IX_Project_Tasks_cat ON dbo.Project_Tasks(category_id);
END
GO

-- Feedback lands here as tasks (screenshot + page URL). Ensure the category exists.
IF NOT EXISTS (SELECT 1 FROM dbo.Project_Categories WHERE code = 'FB')
  INSERT INTO dbo.Project_Categories (code, title, goal, sort_order)
  VALUES ('FB', 'Feedback', 'In-app feedback captured from any page, with a screenshot.', 0);
GO

-- ── Seed from the roadmap (only if the A–E increments aren't there yet) ──────
IF NOT EXISTS (SELECT 1 FROM dbo.Project_Categories WHERE code = 'A')
BEGIN
  INSERT INTO dbo.Project_Categories (code, title, goal, sort_order) VALUES
    ('A', 'Reminder & Concierge Command Center', 'Retire the reminder-count spreadsheet; live view of every CC board.', 1),
    ('B', 'Call Intelligence', 'Surface the Teams call data already in the database; make recordings reachable.', 2),
    ('C', 'Outreach Engine & CC Workflows', 'The backbone — a phased Member Case with cadence-driven outreach.', 3),
    ('D', 'Member Profile 2.0', 'Depth on the member record — dependents, Rx, contacts, search, history.', 4),
    ('E', 'Procurement & Sourcing', 'Cross-team tabs — rebates, sourcing changes, replacement orders.', 5);

  INSERT INTO dbo.Project_Tasks (category_id, title, ref_tag, effort, status, sort_order, description)
  SELECT c.id, v.title, v.ref_tag, v.effort, 'Not Started', v.sort_order, v.descr
  FROM (VALUES
    ('A','Reminder types & stats dashboard','#1','M',1,'Add a reminder_type; live counts + breakdown by type, refreshable, per Concierge.'),
    ('A','Concierge boards, viewable by leadership','#2','M',2,'See any CC''s active reminders without impersonation; edit title/date inline from the board.'),
    ('A','Personal to-do list','#5','S',3,'Lightweight per-staff to-do, separate from client-linked reminders.'),
    ('A','Escalation to leadership','#6','M',4,'Flag/assign a reminder to leadership; a leadership action queue surfaces what needs them.'),
    ('B','Call KPIs & stats','#3','S',1,'Duration, timestamps, answered inbound, per-CC volume — built on teams_call_records (already syncing).'),
    ('B','Call recordings linked to CRM','#4','L',2,'Upload a recording/large file onto a member or call; later pull Teams recording links via Graph.'),
    ('C','Member Case + phase state machine','W1-3','L',1,'Enrollment -> Getting Rx -> Tracking/Delivery, with stage & sub-status per phase.'),
    ('C','Structured attempts + cadence auto-reminders','W1','M',2,'6-attempt enrollment alternating Call/LVM & Text/Email; logging an attempt schedules the next.'),
    ('C','Getting-Rx typed sub-tasks','W2','M',3,'Bloodwork, appointment, pharmacy-transfer consent, Rx follow-up — each its own open thread.'),
    ('C','Tracking & delivery follow-ups','W3','M',4,'Tracking # capture, delay/RTS/attempted-delivery states, delivery confirmation.'),
    ('D','Rx implementation — upload processed Rx','#7','M',1,'Replace the SharePoint drop; store Rx files in Azure Blob against the member.'),
    ('D','Rx by Primary/Dependent, own profile section','#8','M',2,'A dedicated Rx tab; files tagged to the primary or a specific dependent.'),
    ('D','Clearer primary vs dependent modeling','#10','M',3,'Promote relationship/member-type into the member record; make dependents obvious.'),
    ('D','Authorized / secondary contacts','#11','M',4,'A contacts tab for people cleared to speak for the member — name, phone, email, address.'),
    ('D','Search by DOB, drug, task type','#9','S',5,'Extend search beyond name/member-ID to DOB, drug name, and task/reminder type.'),
    ('D','Recently viewed / history log','#12','S',6,'A per-user trail of recently opened profiles.'),
    ('E','Rebate listing when maxed out','#13','M',1,'Surface members at their benefit max; automate where possible. Rules from the R+C team.'),
    ('E','No longer sourcing tab + change alerts','#14','M',2,'A drug-status list; notify the team when procurement pulls a medication from the approved list.'),
    ('E','Replacement order requests tab','#15','L',3,'Move replacement requests off Teams chat into the CRM; notify Procurement, automate the done-state.')
  ) v(code, title, ref_tag, effort, sort_order, descr)
  JOIN dbo.Project_Categories c ON c.code = v.code;
END
GO
