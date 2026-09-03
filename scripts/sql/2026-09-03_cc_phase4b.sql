-- Client Concierge — Phase 4, increment 2: RTS prevention / package delivery support (TRK1)
--   tp_rts_cases     — one delivery-support case per problem shipment
--   tp_rts_contacts  — the daily contact log the SOP requires (Week 1 / Week 2 rules)
--   RTS scripts      — USPS Corporate escalation + local-office delivery note (tp_getrx_scripts)

/* ── tp_rts_cases ────────────────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_rts_cases', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_rts_cases (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    order_id          INT           NOT NULL,
    member_key        NVARCHAR(200) NOT NULL,
    intake_type       NVARCHAR(40)  NOT NULL,
    -- SOP §10 classification — drives which timeline/hold rules apply
    issue_category    NVARCHAR(40)  NOT NULL DEFAULT 'RTS Escalation',
      -- RTS Escalation | Customs Escalation | Invalid Address
    package_type      NVARCHAR(60)  NULL,
      -- Priority Mail Express Intl | Parcel Select | First Class
    medication_type   NVARCHAR(20)  NULL,        -- Refrigerated | Ambient (courtesy-hold length)
    signature_required BIT          NOT NULL DEFAULT 0,
    hold_start_date   DATE          NULL,        -- day 1 of the countdown
    hold_days         INT           NULL,        -- from the package-type table
    hold_extension_days INT         NOT NULL DEFAULT 0,   -- granted courtesy hold
    -- an actionable member plan / scheduled redelivery suppresses the daily requirement
    plan_active       BIT           NOT NULL DEFAULT 0,
    plan_date         DATE          NULL,
    plan_notes        NVARCHAR(500) NULL,
    plan_source       NVARCHAR(40)  NULL,        -- Member Plan | Scheduled Redelivery
    courtesy_hold_requested BIT     NOT NULL DEFAULT 0,
    courtesy_hold_at  DATETIME2     NULL,
    service_requests  NVARCHAR(500) NULL,        -- USPS Service Request number(s)
    status            NVARCHAR(30)  NOT NULL DEFAULT 'Open',   -- Open | Resolved | Returned to Sender | Closed
    resolution        NVARCHAR(200) NULL,
    doc_checklist     NVARCHAR(MAX) NULL,        -- JSON — SOP §12 six requirements
    opened_by         INT           NULL,
    opened_at         DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    closed_by         INT           NULL,
    closed_at         DATETIME2     NULL,
    updated_at        DATETIME2     NULL,
    CONSTRAINT FK_rts_order FOREIGN KEY (order_id) REFERENCES dbo.tp_orders(id)
  );
  CREATE INDEX IX_rts_order  ON dbo.tp_rts_cases (order_id);
  CREATE INDEX IX_rts_status ON dbo.tp_rts_cases (status, hold_start_date);
END
GO

/* ── tp_rts_contacts — the daily log (SOP §12 requirement 1 & 2) ─────── */
IF OBJECT_ID('dbo.tp_rts_contacts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_rts_contacts (
    id           INT IDENTITY(1,1) PRIMARY KEY,
    case_id      INT           NOT NULL,
    contact_date DATE          NOT NULL,
    day_no       INT           NULL,        -- day of the hold countdown
    did_text     BIT           NOT NULL DEFAULT 0,
    did_call     BIT           NOT NULL DEFAULT 0,
    did_email    BIT           NOT NULL DEFAULT 0,
    reached      BIT           NOT NULL DEFAULT 0,
    member_plan  NVARCHAR(500) NULL,        -- what the member committed to, if anything
    carrier_note NVARCHAR(500) NULL,        -- carrier interaction record (§12 requirement 4)
    tracking_status NVARCHAR(200) NULL,     -- tracking check that day (§12 requirement 5)
    notes        NVARCHAR(MAX) NULL,
    created_by   INT           NULL,
    created_at   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_rtsc_case FOREIGN KEY (case_id) REFERENCES dbo.tp_rts_cases(id)
  );
  CREATE INDEX IX_rtsc_case ON dbo.tp_rts_contacts (case_id, contact_date);
END
GO

/* ── RTS scripts (SOP required language) ─────────────────────────────── */
MERGE dbo.tp_getrx_scripts AS t
USING (VALUES
  (N'usps-corporate', N'USPS Corporate Escalation — Required Language', N'rts', 'EN', 50,
     N'Call USPS Corporate and use this language exactly:
"I am calling about a package for the RECIPIENT." — refer to the member ONLY as the recipient, never as the shipper.
1. Verify the recipient name and full delivery address.
2. State that the package contains PRESCRIPTION MEDICATION.
3. Provide the estimated value (take it from the order''s Transaction tab).
4. Provide the recipient''s phone number.
5. Provide your own staff email for the follow-up.
6. Ask for and write down the SERVICE REQUEST NUMBER before ending the call.
Record the Service Request number on this case AND in the task note.'),
  (N'usps-local-note', N'Local USPS Office — Recommended Delivery Note', N'rts', 'EN', 51,
     N'URGENT: Prescription medication. Please hold until {{hold_date}}. Do not return to sender. Recipient has been contacted and will collect. Please contact the recipient at the number on the label if any issue arises.'),
  (N'usps-courtesy-hold', N'Local USPS Courtesy Hold Request', N'rts', 'EN', 52,
     N'Call the LOCAL post office (USPS Corporate cannot grant this — only the local office can):
"I am calling about a package for the recipient at [address]. It contains prescription medication. Could you please extend the hold by {{extension}}? The recipient is arranging collection."
Note the name of the clerk you spoke to and add it to the case.')
) AS s(script_key, title, trigger_point, lang, sort_order, script_text)
ON t.script_key = s.script_key
WHEN NOT MATCHED THEN
  INSERT (script_key, title, trigger_point, lang, sort_order, script_text)
  VALUES (s.script_key, s.title, s.trigger_point, s.lang, s.sort_order, s.script_text);
GO
