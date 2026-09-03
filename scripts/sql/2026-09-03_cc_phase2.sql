-- Client Concierge — Phase 2 (CC2 outreach automation + RXF1 cadence engine)
--   * priority on tp_member_intakes drives the follow-up cadence (RXF1)
--   * an editable "address verification" outreach template (attempt_no 0) for CC2

/* ── priority on the intake (RXF1 cadence engine) ────────────────────── */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.tp_member_intakes') AND name = 'priority')
  ALTER TABLE dbo.tp_member_intakes ADD priority NVARCHAR(20) NOT NULL CONSTRAINT DF_intake_priority DEFAULT 'Medium';
GO

-- Tag which contact-log rows are outreach-cadence attempts (1-6) so address-verification
-- texts and ad-hoc contacts don't inflate the attempt counter.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.GLP1_ContactLog') AND name = 'outreach_attempt')
  ALTER TABLE dbo.GLP1_ContactLog ADD outreach_attempt INT NULL;
GO

/* ── address-verification template (CC2) — attempt_no 0 = not part of the 1-6 cadence ── */
MERGE dbo.tp_outreach_scripts AS t
USING (VALUES
  (N'*', 0, N'Address Verification', N'Text', 0,
     N'Address Verification Text',
     N'Hi {{first_name}}, this is True Path Sourcing. Please confirm your shipping address so we can send your medication: {{address_link}}. Thank you!')
) AS s(intake_type, attempt_no, channel, log_as, booking_link, title, script_text)
ON t.intake_type = s.intake_type AND t.attempt_no = s.attempt_no
WHEN NOT MATCHED THEN
  INSERT (intake_type, attempt_no, channel, log_as, booking_link, title, script_text, updated_at)
  VALUES (s.intake_type, s.attempt_no, s.channel, s.log_as, s.booking_link, s.title, s.script_text, SYSUTCDATETIME());
GO
