-- ─────────────────────────────────────────────────────────────────────────────
-- Roadmap v2 — the True Path Sourcing business flow. Adds the client lifecycle
-- stages (S1-S10), AMT reporting, and executive dashboards as project categories,
-- and re-sorts the original platform increments (A-E) to sit after them.
-- Open questions from the source doc are captured inline (prefixed "Q:").
--   node scripts/run-sql.js netlify/database/sqlserver/020_business_flow_roadmap.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Keep Feedback at the top; push the platform increments below the lifecycle.
UPDATE dbo.Project_Categories SET sort_order = 30, title = 'Platform — Reminder & Concierge Command Center' WHERE code = 'A';
UPDATE dbo.Project_Categories SET sort_order = 31, title = 'Platform — Call Intelligence' WHERE code = 'B';
UPDATE dbo.Project_Categories SET sort_order = 32, title = 'Platform — Outreach Engine (powers Stage 7)' WHERE code = 'C';
UPDATE dbo.Project_Categories SET sort_order = 33, title = 'Platform — Member Profile 2.0' WHERE code = 'D';
UPDATE dbo.Project_Categories SET sort_order = 34, title = 'Platform — Procurement & Sourcing' WHERE code = 'E';
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Project_Categories WHERE code = 'S1')
BEGIN
  INSERT INTO dbo.Project_Categories (code, title, goal, sort_order) VALUES
    ('AMT','AMT Reporting & Claims Automation','Automated billing/enrollment/eligibility reports + high-cost claim alerts.',10),
    ('S1','Stage 1 — Client Won (Implementation Pipeline)','Sales/AMT: verbal win through implementation initiated.',11),
    ('S2','Stage 2 — Contract Management','AMT + Legal (Kristie): request through executed contract.',12),
    ('S3','Stage 3 — Client Setup','CRM profile, SharePoint, marketing, and financial setup.',13),
    ('S4','Stage 4 — Client Document Collection','File-status tracking + client readiness %.',14),
    ('S5','Stage 5 — Implementation Call','Scheduling, participants, and the go-live checklist.',15),
    ('S6','Stage 6 — Go-Live Preparation','Member/eligibility upload and outreach readiness.',16),
    ('S7','Stage 7 — Member Outreach (Concierge)','The largest section — client & member status with the 6-attempt cadence.',17),
    ('S8','Stage 8 — Active Client Management','Ongoing status, reporting, and invoicing.',18),
    ('S9','Stage 9 — Escalations','Org-wide escalation tracking for every department.',19),
    ('S10','Stage 10 — Growth & Expansion','6-month reviews and upsell/referral opportunities (Amanda).',20),
    ('DASH','Executive Dashboards','Leadership views: Implementation, Operations, and AM.',21);

  INSERT INTO dbo.Project_Tasks (category_id, title, effort, status, sort_order, description)
  SELECT c.id, v.title, v.effort, v.status, v.sort, v.descr
  FROM (VALUES
    ('AMT','AMT reporting automation — billing, enrollment (utilization) & eligibility','L','In Progress',1,
      'OnBase-style automated + emailed reports to AMT. Foundation exists (reconcile.py AMT emails for MCR/Anders); generalize to all clients and add billing + utilization report types.'),
    ('AMT','High-cost drug/member alerts from claims','M','Not Started',2,
      'Flag any claim over $2,000 not on the client drug list; notify AMT of new high-cost drugs/eligible members. Configurable override threshold per AMT.'),

    ('S1','Client Won pipeline — statuses & fields','L','Not Started',1,
      'Statuses: Verbal Win Confirmed, Intake Form Pending/Submitted/Reviewed/Approved, Implementation Initiated. Fields: Client Name, Program Type (International/GLP-1/Both), Broker POC, Effective + Go-Live dates, Account Executive, Contract Value + notes, Imprest Funds (Y/N/NA), Drug List, Pricing List (RESTRICT to AMT/Procurement/Leadership), Savings Analysis, Rebate Requirements, Data Cadence. Q: should Stage 1 be a won/lost/in-progress pipeline?'),
    ('S1','Intake Submitted automations','M','Not Started',2,
      'On Intake Form Submitted: notify Account Management, Sales Coordinator, Operations Leadership; create SharePoint client-folder request; create contract-request task. Q: confirm contract-request timing (sales usually before intake).'),

    ('S2','Contract Management pipeline — statuses & fields','M','Not Started',1,
      'Statuses: Contract Requested, In Progress, Review, Ready for Signature, Sent to Client, Awaiting Signature, Client Revisions Requested, Executed. Fields: Request/Sent/Executed dates, Legal Owner, Revision Notes. Q: does this sequence before Client Won?'),
    ('S2','Contract automations + SLA timer','M','Not Started',2,
      'On Requested: follow-up task + SLA (service-level) timer. On Executed: trigger intake-to-sales, then implementation-to-AMT and assign AM + Coordinator.'),

    ('S3','Client Setup pipeline — statuses & fields','M','Not Started',1,
      'CRM profile created, SharePoint folder, marketing (logo/flyer), financial setup. Q: QR code / enrollment link likely sunset (generic website QR + built-in scheduler).'),
    ('S3','Setup automations + banking flow','M','Not Started',2,
      'Banking info direction is TPS accounting -> client (correct in build). Replace "Banking Approved" with "Imprest Deposit Received". On Setup Complete: intro email (confirm auto-send vs AM review), assign Account Manager EARLIER (right after contract execution).'),

    ('S4','Document Collection — file-status tracking','L','Not Started',1,
      'Per-file status for Claims / Eligibility / Member Contact files (SFTP Set Up, Requested, Received, Validation Needed, Approved). Additional contacts: HR, Finance, IT, Broker. Overall stage status. Q: are Validation/Approved needed for claims & eligibility?'),
    ('S4','Client Readiness %','S','Not Started',2,
      'Auto-computed completeness (e.g., Claims + Eligibility complete, Member Contact missing = 66%).'),

    ('S5','Implementation Call — statuses, participants, checklist','M','Not Started',1,
      'Statuses: Not Scheduled, Scheduled, Completed, Follow-Up Required, Approved for Go Live. Participants: client contact, broker, consultant, AM, coordinator, operations. Checklist: Marketing Approved, File Feed Established, Outreach Strategy Approved, Reporting Schedule, Escalation Path. All checked -> move to Go-Live Prep.'),

    ('S6','Go-Live Preparation — statuses & fields','M','Not Started',1,
      'Member/eligibility upload statuses through Ready for Go Live. Fields: eligible member count, upload date, expected outreach date, outreach campaign. On Ready for Go Live: notify Concierge leadership.'),

    ('S7','Member Outreach — client & member status + 6-attempt cadence','L','Not Started',1,
      'Client-level: Outreach Not Started/Active, Implementation In Progress/Complete, Ongoing Support. Member-level: Not Contacted, Text/Email Sent, Call Attempt 1-3, Interested, Application Started, Documentation Pending, Submitted, Approved, Enrolled, Declined, Inactive. Builds on Platform Increment C. Q: define "Inactive".'),
    ('S7','Outreach audit history','M','Not Started',2,
      'Every status change records date, user, outcome, and notes.'),
    ('S7','Third-party contact verification (idea)','S','Not Started',3,
      'Explore a contact-verification vendor to improve member phone/email accuracy where clients cannot verify.'),

    ('S8','Active Client Management — status & KPIs','M','Not Started',1,
      'Statuses: Active, Monitoring, Expansion Opportunity, At Risk, Escalated, Renewal Pending, Renewed, Terminated. Fields: active members + utilization, total savings, wellness credits paid, open escalations, satisfaction score.'),
    ('S8','Reporting & invoicing + report specs','L','Not Started',2,
      'Enrollment report: Company, Member Name, TPS Member ID, DOB, Medication, NDC, Type (Primary/Dependent), Enrollment Status. Billing report: Company, Location, Member IDs/Names/DOB, NDC/AWP, TPS paid, wellness credits (until maxed). Invoice Pending/Sent/Paid. Q: how much eligibility reporting becomes background automation?'),

    ('S9','Escalations — types & statuses (org-wide)','M','Not Started',1,
      'Types: Member, Client, Claims, Eligibility, Billing, Procurement, Contract. Statuses: Open, Assigned, In Review, Pending Client, Pending Internal, Resolved/Closed. Available to every department; extends Platform Increment A escalation.'),

    ('S10','Growth & Expansion pipeline','M','Not Started',1,
      'Statuses: Expansion Review Pending, 6-Month Review Scheduled, Opportunity Identified, Introduced to Sales, Proposal Sent, Closed Won/Lost. Fields: additional programs recommended, savings/upsell/referral opportunity, new high-cost drugs & members.'),

    ('DASH','Executive dashboards','L','Not Started',1,
      'Implementation (waiting for contracts/files/impl call, ready for go-live, live). Operations (active clients/members, enrollment %, claims/eligibility received %, outstanding escalations). AM (clients assigned, open tasks, missing documentation, upcoming go-lives, expansion opportunities).')
  ) v(code, title, effort, status, sort, descr)
  JOIN dbo.Project_Categories c ON c.code = v.code;
END
GO
