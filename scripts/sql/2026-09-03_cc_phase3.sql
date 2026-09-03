-- Client Concierge — Phase 3, increment 1: the Get Rx prescriber-chase stage
--   tp_orders          — the order ticket created after enrollment (medication + fulfillment lifecycle)
--   tp_getrx_attempts  — the prescriber-outreach attempt tracker (fax/call/refax/MRC/verbal)
--   tp_getrx_scripts   — predefined Get Rx scripts surfaced at attempt 4+ / verbal handoff

/* ── tp_orders ───────────────────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_orders', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_orders (
    id               INT IDENTITY(1,1) PRIMARY KEY,
    member_key       NVARCHAR(200) NOT NULL,
    intake_type      NVARCHAR(40)  NOT NULL,
    medication       NVARCHAR(200) NULL,
    strength         NVARCHAR(100) NULL,
    day_supply       INT           NULL,
    supply_on_hand   NVARCHAR(100) NULL,   -- existing members: what they still have
    enrollment_notes NVARCHAR(MAX) NULL,
    stage            NVARCHAR(40)  NOT NULL DEFAULT 'Get Rx',  -- Get Rx → Rx Received → Processing → Verify Address → Ordered
    getrx_status     NVARCHAR(40)  NULL,    -- New | Faxed | Follow-up Call | Refaxed | MRC Escalation | Verbal Request | Rx Received
    priority         NVARCHAR(20)  NOT NULL DEFAULT 'Medium',
    active_rx_checked BIT          NOT NULL DEFAULT 0,   -- RXF1 active-Rx pre-check gate
    active_rx_found  BIT           NULL,
    assigned_to      INT           NULL,    -- Users.id (the concierge)
    closed           BIT           NOT NULL DEFAULT 0,
    created_by       INT           NULL,
    created_at       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at       DATETIME2     NULL
  );
  CREATE INDEX IX_orders_member ON dbo.tp_orders (member_key, intake_type);
  CREATE INDEX IX_orders_stage  ON dbo.tp_orders (stage, closed);
END
GO

/* ── tp_getrx_attempts ──────────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_getrx_attempts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_getrx_attempts (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    order_id       INT           NOT NULL,
    attempt_no     INT           NOT NULL,
    target         NVARCHAR(30)  NOT NULL,   -- Prescriber | Member | BA
    channel        NVARCHAR(30)  NOT NULL,   -- Fax | Call | LVM | Text | Email
    phone_tree     NVARCHAR(80)  NULL,       -- which phone-tree option was used
    turnaround_days INT          NULL,       -- prescriber turnaround estimate (overrides cadence)
    notes          NVARCHAR(MAX) NULL,
    outcome        NVARCHAR(80)  NULL,
    followup_date  DATE          NULL,
    created_by     INT           NULL,
    created_at     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_getrx_order FOREIGN KEY (order_id) REFERENCES dbo.tp_orders(id)
  );
  CREATE INDEX IX_getrx_order ON dbo.tp_getrx_attempts (order_id, attempt_no);
END
GO

/* ── tp_getrx_scripts ───────────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_getrx_scripts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_getrx_scripts (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    script_key    NVARCHAR(40)  NOT NULL UNIQUE,
    title         NVARCHAR(160) NOT NULL,
    trigger_point NVARCHAR(40)  NOT NULL,   -- member-4plus | verbal | general
    script_text   NVARCHAR(MAX) NULL,
    active        BIT           NOT NULL DEFAULT 1,
    sort_order    INT           NOT NULL DEFAULT 0
  );
END
GO

MERGE dbo.tp_getrx_scripts AS t
USING (VALUES
  (N'unable-refills', N'Unable to Receive Refills from Prescriber', N'member-4plus', 10,
     N'Hi {{first_name}}, we''ve tried several times to obtain your prescription from your provider without success. To keep your medication on track, we may need your help contacting the prescriber or providing an alternate provider. Please call us at [Callback #].'),
  (N'urgent-3rd', N'URGENT / 3rd+ Outreach Attempt', N'member-4plus', 20,
     N'Hi {{first_name}}, this is an urgent follow-up regarding your prescription. We still need the prescriber to send your Rx. Please reach out to your provider''s office or call us at [Callback #] so we can help avoid a delay in your medication.'),
  (N'verbal-request', N'Verbal Rx Request (BA → Cypress)', N'verbal', 30,
     N'Verbal Rx request — member {{first_name}}: prescriber unresponsive after outreach. Requesting BA submit a verbal Rx request to Cypress. Prescriber and medication details attached to the order.')
) AS s(script_key, title, trigger_point, sort_order, script_text)
ON t.script_key = s.script_key
WHEN NOT MATCHED THEN
  INSERT (script_key, title, trigger_point, sort_order, script_text)
  VALUES (s.script_key, s.title, s.trigger_point, s.sort_order, s.script_text);
GO
