-- Client Concierge — Phase 1 (IA4 work queue + CC1 enrollment outreach)
-- New tables:
--   tp_outreach_scripts     — the 6-attempt enrollment-outreach cadence + per-attempt script text (editable; LIB1 later)
--   tp_review_close         — Review & Close queue (seed; Phase 5 builds the full workspace)
--   tp_enrollment_worksheet — per-member enrollment profile-confirmation checklist (CC1 / ENR1)

/* ── tp_outreach_scripts ─────────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_outreach_scripts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_outreach_scripts (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    intake_type   NVARCHAR(40)  NOT NULL,   -- '*' = default cadence, or a specific type code (GLP1, NONGLP1…)
    attempt_no    INT           NOT NULL,   -- 1..6
    channel       NVARCHAR(60)  NOT NULL,   -- human label, e.g. 'Call + Voicemail'
    log_as        NVARCHAR(40)  NOT NULL,   -- ContactLog contact_type to record: Phone Call | Text | Email | Other
    booking_link  BIT           NOT NULL DEFAULT 0,
    title         NVARCHAR(160) NOT NULL,
    script_text   NVARCHAR(MAX) NULL,
    active        BIT           NOT NULL DEFAULT 1,
    updated_at    DATETIME2     NULL,
    CONSTRAINT UQ_outreach_type_attempt UNIQUE (intake_type, attempt_no)
  );
END
GO

-- Seed the default 6-attempt cadence (idempotent — only inserts missing attempts).
MERGE dbo.tp_outreach_scripts AS t
USING (VALUES
  (N'*', 1, N'Call + Voicemail',        N'Phone Call', 0,
     N'Attempt 1 — Call + Voicemail',
     N'Hi {{first_name}}, this is [Your Name] calling from True Path Sourcing on behalf of your prescription benefit. We have a program that can help you get your medication at little or no cost. Please call me back at [Callback #]. Thank you!'),
  (N'*', 2, N'Text (no booking link)',  N'Text', 0,
     N'Attempt 2 — Text',
     N'Hi {{first_name}}, this is [Your Name] with True Path Sourcing regarding your prescription benefit. We''d love to help you save on your medication — what''s a good time to connect? Reply here or call [Callback #].'),
  (N'*', 3, N'Call + Voicemail + Text',  N'Phone Call', 1,
     N'Attempt 3 — Call + Voicemail + Text (booking link)',
     N'Hi {{first_name}}, [Your Name] with True Path Sourcing again. You can book a quick call with me here: {{booking_link}} — or reply/call [Callback #]. We can help you get your medication covered.'),
  (N'*', 4, N'Text / Email (booking link)', N'Text', 1,
     N'Attempt 4 — Text / Email (booking link)',
     N'Hi {{first_name}}, following up from True Path Sourcing about your prescription benefit. Grab a time that works for you here: {{booking_link}}. We''re here to help.'),
  (N'*', 5, N'Email (booking link)',     N'Email', 1,
     N'Attempt 5 — Email (booking link)',
     N'Hi {{first_name}}, we''ve tried to reach you about a benefit that can lower your medication cost. Please schedule a quick call at your convenience: {{booking_link}}. — True Path Sourcing'),
  (N'*', 6, N'Final Text / Email (booking link)', N'Text', 1,
     N'Attempt 6 — Final outreach (booking link)',
     N'Hi {{first_name}}, this is our final outreach regarding your prescription benefit. If you''d still like help saving on your medication, book here anytime: {{booking_link}}. — True Path Sourcing')
) AS s(intake_type, attempt_no, channel, log_as, booking_link, title, script_text)
ON t.intake_type = s.intake_type AND t.attempt_no = s.attempt_no
WHEN NOT MATCHED THEN
  INSERT (intake_type, attempt_no, channel, log_as, booking_link, title, script_text, updated_at)
  VALUES (s.intake_type, s.attempt_no, s.channel, s.log_as, s.booking_link, s.title, s.script_text, SYSUTCDATETIME());
GO

/* ── tp_review_close ─────────────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_review_close', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_review_close (
    member_key   NVARCHAR(200) NOT NULL,
    intake_type  NVARCHAR(40)  NOT NULL,
    reason       NVARCHAR(200) NULL,       -- e.g. 'Non-Responsive (6 attempts)', 'Invalid Information', 'Opted Out'
    status       NVARCHAR(30)  NOT NULL DEFAULT 'Open',  -- Open | Recycled | Closed
    routed_by    INT           NULL,       -- Users.id, or NULL when auto-routed by the system
    routed_at    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    resolved_by  INT           NULL,
    resolved_at  DATETIME2     NULL,
    notes        NVARCHAR(MAX) NULL,
    CONSTRAINT PK_review_close PRIMARY KEY (member_key, intake_type)
  );
END
GO

/* ── tp_enrollment_worksheet ─────────────────────────────────────────── */
IF OBJECT_ID('dbo.tp_enrollment_worksheet', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tp_enrollment_worksheet (
    member_key   NVARCHAR(200) NOT NULL,
    intake_type  NVARCHAR(40)  NOT NULL,
    data         NVARCHAR(MAX) NULL,       -- JSON: confirmed fields + order-ticket notes
    updated_by   INT           NULL,
    updated_at   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_enrollment_worksheet PRIMARY KEY (member_key, intake_type)
  );
END
GO
