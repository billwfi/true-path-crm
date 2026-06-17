-- ─────────────────────────────────────────────────────────────────────────────
-- Marketing › Schedulers: MS Bookings-style appointment scheduling tools.
-- A "scheduler" defines a date range, a daily time window, a slot interval, and
-- a per-slot capacity. It is shared publicly via a random public_id (URL + QR),
-- and members of the public self-book into generated time slots.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/005_marketing_schedulers.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.Booking_Schedulers', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Booking_Schedulers (
    id               INT IDENTITY(1,1) PRIMARY KEY,
    -- Random opaque token used in the shareable public URL (/book/?s=<public_id>).
    public_id        NVARCHAR(40)  NOT NULL,
    name             NVARCHAR(200) NOT NULL,
    description      NVARCHAR(MAX) NULL,
    location         NVARCHAR(300) NULL,
    start_date       DATE          NOT NULL,
    end_date         DATE          NOT NULL,
    -- Daily booking window, stored as 'HH:mm' (24h).
    day_start_time   NVARCHAR(5)   NOT NULL CONSTRAINT DF_BS_daystart DEFAULT '09:00',
    day_end_time     NVARCHAR(5)   NOT NULL CONSTRAINT DF_BS_dayend   DEFAULT '17:00',
    -- Length of each appointment slot, in minutes.
    interval_minutes INT           NOT NULL CONSTRAINT DF_BS_interval DEFAULT 30,
    -- How many appointments may be booked per slot.
    capacity_per_slot INT          NOT NULL CONSTRAINT DF_BS_capacity DEFAULT 10,
    -- CSV of active weekdays, 0=Sun .. 6=Sat. Default Mon–Fri.
    days_of_week     NVARCHAR(20)  NOT NULL CONSTRAINT DF_BS_dow DEFAULT '1,2,3,4,5',
    active           BIT           NOT NULL CONSTRAINT DF_BS_active DEFAULT 1,
    created_by       INT           NULL,
    created_at       DATETIME      NOT NULL CONSTRAINT DF_BS_created DEFAULT GETDATE(),
    updated_at       DATETIME      NOT NULL CONSTRAINT DF_BS_updated DEFAULT GETDATE()
  );
  CREATE UNIQUE INDEX UX_Booking_Schedulers_public ON dbo.Booking_Schedulers(public_id);
END
GO

IF OBJECT_ID('dbo.Bookings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Bookings (
    id           INT IDENTITY(1,1) PRIMARY KEY,
    scheduler_id INT           NOT NULL,
    -- The specific slot start (naive local datetime).
    slot_start   DATETIME      NOT NULL,
    name         NVARCHAR(200) NOT NULL,
    email        NVARCHAR(200) NULL,
    phone        NVARCHAR(50)  NULL,
    notes        NVARCHAR(MAX) NULL,
    created_at   DATETIME      NOT NULL CONSTRAINT DF_BK_created DEFAULT GETDATE()
  );
  CREATE INDEX IX_Bookings_scheduler_slot ON dbo.Bookings(scheduler_id, slot_start);
END
GO
