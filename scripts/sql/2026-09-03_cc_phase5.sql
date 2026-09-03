-- Client Concierge — Phase 5, increment 1: Review & Close workspace + rebate engine
--   RC1  verify delivery, RTS escalation, missing transaction, rebate auto-create
--   RC2  standardized close reasons (WHY + WHO), 'Invalid Information' status
--   CC3  member outreach status flags + recycling queue
--   RCS1 Issue Rebate task template, rebate status enum, drug rules, transaction-date gate,
--        enrollment close-out checklist, ticket status definitions

/* ── review & close case: what the reviewer decides ──────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.tp_review_close') AND name='close_reason')
  ALTER TABLE dbo.tp_review_close ADD
    close_reason       NVARCHAR(60)  NULL,   -- standardized reason (RC2)
    close_detail       NVARCHAR(500) NULL,   -- the WHY, in the reviewer's words
    authorized_by      NVARCHAR(120) NULL,   -- the WHO — AMT / BA / Procurement contact
    member_status      NVARCHAR(40)  NULL,   -- Non-Responsive | Invalid Information | Opted Out | Enrolled and Ordering
    delivery_verified  BIT           NOT NULL CONSTRAINT DF_rc_delv DEFAULT 0,
    transaction_present BIT          NOT NULL CONSTRAINT DF_rc_txn  DEFAULT 0,
    rts_flagged        BIT           NOT NULL CONSTRAINT DF_rc_rts  DEFAULT 0,
    checklist          NVARCHAR(MAX) NULL,   -- JSON: reviewer close-out checklist
    deferred_until     DATE          NULL,   -- missing transaction pushes R&C out 3-4 days
    reviewed_by        INT           NULL,
    reviewed_at        DATETIME2     NULL;
GO

/* ── member outreach status + ticket status on the intake (CC3, RCS1) ── */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.tp_member_intakes') AND name='outreach_status')
  ALTER TABLE dbo.tp_member_intakes ADD
    outreach_status NVARCHAR(40) NULL,        -- Non-Responsive | Invalid Information | Opted Out | Enrolled and Ordering
    outreach_status_at DATETIME2 NULL,
    recycle_after   DATE         NULL,        -- when to re-attempt (recycling queue)
    ticket_status   NVARCHAR(20) NOT NULL CONSTRAINT DF_mi_ticket DEFAULT 'Open';
                                              -- Open | In Progress | Answered | Closed
GO

/* ── rebates (RC1 + RCS1) ────────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_rebates', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_rebates (
    id               INT IDENTITY(1,1) PRIMARY KEY,
    member_key       NVARCHAR(200) NOT NULL,
    intake_type      NVARCHAR(40)  NOT NULL,
    order_id         INT           NULL,
    medication       NVARCHAR(200) NULL,
    strength         NVARCHAR(100) NULL,
    day_supply       INT           NULL,
    -- SOP: the only valid statuses are UNPAID, MAXED OUT, N/A
    rebate_status    NVARCHAR(20)  NOT NULL DEFAULT 'UNPAID',
    monthly_amount   DECIMAL(18,2) NULL,      -- Monthly Rebate Amount
    amount_to_issue  DECIMAL(18,2) NULL,      -- Rebate to be Issued
    rule_applied     NVARCHAR(120) NULL,      -- which drug rule produced the amount
    transaction_number NVARCHAR(80) NULL,
    order_number     NVARCHAR(80)  NULL,
    tracking_numbers NVARCHAR(500) NULL,      -- US & international
    transaction_date DATE          NULL,      -- gate: RTS 1/11/2099, customs 12/31/2099
    aub_number       NVARCHAR(60)  NULL,
    rebate_address   NVARCHAR(300) NULL,
    proof_of_delivery NVARCHAR(500) NULL,
    checklist        NVARCHAR(MAX) NULL,      -- JSON close-out bubbles
    status           NVARCHAR(20)  NOT NULL DEFAULT 'Open',   -- Open | Completed
    task_id          INT           NULL,      -- dbo.tp_tasks row
    created_by       INT           NULL,
    created_at       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    completed_by     INT           NULL,
    completed_at     DATETIME2     NULL,
    updated_at       DATETIME2     NULL
  );
  CREATE INDEX IX_reb_member ON dbo.tp_rebates (member_key, intake_type);
  CREATE INDEX IX_reb_status ON dbo.tp_rebates (status, rebate_status);
END
GO

/* ── biosimilar / brand mapping used by the rebate rules ─────────────── */
IF OBJECT_ID('dbo.tp_rebate_drug_rules', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_rebate_drug_rules (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    drug          NVARCHAR(120) NOT NULL UNIQUE,
    maps_to       NVARCHAR(120) NULL,        -- biosimilar → reference brand
    is_biosimilar BIT           NOT NULL DEFAULT 0,
    amount_per_30 DECIMAL(18,2) NULL,        -- rebate per 30 days
    max_day_supply INT          NULL,        -- e.g. Tirzepatide is 30-day only
    notes         NVARCHAR(300) NULL,
    active        BIT           NOT NULL DEFAULT 1
  );
END
GO

MERGE dbo.tp_rebate_drug_rules AS t
USING (VALUES
  (N'HADLIMA',     N'HUMIRA',  1, 150.00, NULL, N'Biosimilar — $150 per 30 days, counts as a new medication'),
  (N'WEZLANA',     N'STELARA', 1, 150.00, NULL, N'Biosimilar — $150 per 30 days, counts as a new medication'),
  (N'TIRZEPATIDE', NULL,       0,  50.00,   30, N'30-day supply only, $50 per 30 days'),
  (N'MOUNJARO',    N'TIRZEPATIDE', 0, 50.00, 30, N'Tirzepatide brand — 30-day only, $50 per 30 days'),
  (N'ZEPBOUND',    N'TIRZEPATIDE', 0, 50.00, 30, N'Tirzepatide brand — 30-day only, $50 per 30 days')
) AS s(drug, maps_to, is_biosimilar, amount_per_30, max_day_supply, notes)
ON t.drug = s.drug
WHEN NOT MATCHED THEN
  INSERT (drug, maps_to, is_biosimilar, amount_per_30, max_day_supply, notes)
  VALUES (s.drug, s.maps_to, s.is_biosimilar, s.amount_per_30, s.max_day_supply, s.notes);
GO

/* ── RC2: flag an outreach attempt as reaching invalid contact details ── */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.GLP1_ContactLog') AND name='invalid_contact')
  ALTER TABLE dbo.GLP1_ContactLog ADD invalid_contact BIT NOT NULL CONSTRAINT DF_cl_invalid DEFAULT 0;
GO
