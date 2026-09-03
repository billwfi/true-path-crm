-- Client Concierge — Phase 4, increment 1: Procurement hand-off + Shipping/Tracking
--   IA5  Registered-for-Services state, procurement hand-off (tp_batch), status back on intake
--   CC5  tracking task: shipment number, member text, carrier monitoring, delivery confirmation, delays
--   RC2  order-ticket auto-create on enrollment close, per-medication order tasks + Rx-driven reminders,
--        medication + rebate amount on the first order task

/* ── IA5: 'Registered for Services' as a terminal state on every intake type ── */
UPDATE dbo.tp_intake_types
   SET statuses = N'["In Progress", "Outreach Completed", "Submitted to WellSync", "Registered for Services"]',
       sub_statuses = N'{"Submitted to WellSync": ["Declined Enrollment", "Approved", "Clinical Denial"], "Registered for Services": ["Order Created", "Awaiting Fulfillment"]}',
       updated_at = SYSUTCDATETIME()
 WHERE code = 'GLP1'
   AND statuses NOT LIKE '%Registered for Services%';
GO

/* ── CC5 + IA5: fulfillment / shipping / tracking on the order ── */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.tp_orders') AND name='address_verified')
  ALTER TABLE dbo.tp_orders ADD
    address_verified      BIT           NOT NULL CONSTRAINT DF_ord_addrver DEFAULT 0,
    address_verified_at   DATETIME2     NULL,
    batch_id              INT           NULL,      -- dbo.tp_batch.id — the procurement hand-off
    handed_off_at         DATETIME2     NULL,
    carrier               NVARCHAR(60)  NULL,      -- USPS, UPS, FedEx…
    tracking_number       NVARCHAR(120) NULL,
    shipped_date          DATE          NULL,
    tracking_texted_at    DATETIME2     NULL,      -- member was sent the tracking text
    last_carrier_status   NVARCHAR(120) NULL,
    last_carrier_check    DATETIME2     NULL,
    delivered_date        DATE          NULL,
    delivery_confirmed    BIT           NOT NULL CONSTRAINT DF_ord_delconf DEFAULT 0,
    delivery_confirmed_at DATETIME2     NULL,
    delay_flag            BIT           NOT NULL CONSTRAINT DF_ord_delay DEFAULT 0,
    delay_notes           NVARCHAR(MAX) NULL,
    run_out_date          DATE          NULL,      -- drives the order-task due date (RC2)
    rebate_group          NVARCHAR(120) NULL,
    rebate_monthly        DECIMAL(18,2) NULL,
    rebate_annual         DECIMAL(18,2) NULL;
GO

/* ── CC5: carrier / delivery event log ─────────────────────────────────── */
IF OBJECT_ID('dbo.tp_tracking_events', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_tracking_events (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    order_id    INT           NOT NULL,
    event_type  NVARCHAR(40)  NOT NULL,   -- Shipped | Tracking Texted | Carrier Check | Delivered | Delivery Call | Delay | RTS
    status      NVARCHAR(120) NULL,       -- carrier status text
    notes       NVARCHAR(MAX) NULL,
    occurred_at DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    created_by  INT           NULL,
    CONSTRAINT FK_trk_order FOREIGN KEY (order_id) REFERENCES dbo.tp_orders(id)
  );
  CREATE INDEX IX_trk_order ON dbo.tp_tracking_events (order_id, occurred_at);
END
GO

/* ── CC5: tracking text template (reuses the outreach-script table, attempt_no -1) ── */
MERGE dbo.tp_outreach_scripts AS t
USING (VALUES
  (N'*', -1, N'Tracking Notification', N'Text', 0,
     N'Shipment Tracking Text',
     N'Hi {{first_name}}, good news — your medication has shipped! Track it here: {{tracking_link}} (tracking #{{tracking_number}}). Please make sure someone is available to receive it. — True Path Sourcing')
) AS s(intake_type, attempt_no, channel, log_as, booking_link, title, script_text)
ON t.intake_type = s.intake_type AND t.attempt_no = s.attempt_no
WHEN NOT MATCHED THEN
  INSERT (intake_type, attempt_no, channel, log_as, booking_link, title, script_text, updated_at)
  VALUES (s.intake_type, s.attempt_no, s.channel, s.log_as, s.booking_link, s.title, s.script_text, SYSUTCDATETIME());
GO
