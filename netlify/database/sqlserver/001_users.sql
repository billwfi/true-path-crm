-- ─────────────────────────────────────────────────────────────────────────────
-- User Management — SQL Server (iRx) is now the system of record for app users.
-- Run once against the iRx database, then run scripts/seed-users.js to copy the
-- existing Postgres tp_staff rows into this table (preserving id values so all
-- existing references stay valid: tp_clients.account_coordinator,
-- tp_leads.assigned_id, tp_tasks.assigned_id, and GLP1 assigned_to/assigned_by).
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.Users', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Users (
    id            INT          NOT NULL PRIMARY KEY,  -- explicit (matches tp_staff.id); NOT identity
    email         NVARCHAR(255) NOT NULL,
    password_hash NVARCHAR(255) NOT NULL,
    firstname     NVARCHAR(100),
    lastname      NVARCHAR(100),
    -- 'Admin' can manage users and set/reset passwords; 'User' cannot.
    user_type     NVARCHAR(20)  NOT NULL CONSTRAINT DF_Users_user_type DEFAULT 'User',
    -- Feature-level role kept for GLP1 logic: 'Admin','Call Center Manager','Client Concierge','Staff'
    role          NVARCHAR(50)  NOT NULL CONSTRAINT DF_Users_role DEFAULT 'Staff',
    -- CSV of left-nav sections this user may see, e.g. 'Main,Pharmacy,GLP1'.
    -- NULL/empty for Admins (Admins always see every section).
    nav_access    NVARCHAR(500),
    active        BIT           NOT NULL CONSTRAINT DF_Users_active DEFAULT 1,
    created_at    DATETIME      NOT NULL CONSTRAINT DF_Users_created DEFAULT GETDATE()
  );

  CREATE UNIQUE INDEX UX_Users_email ON dbo.Users(email);
END
GO
