-- Demo data for the Client Concierge screens, under the TruePath Test client (TPTEST).
-- Covers My Queue (overdue / due today / unworked / Review & Close / priorities),
-- Rx Processing, Shipping & Tracking, Delivery Support (RTS) and Cypress requests.
--
-- Safe to re-run: it clears and recreates only demo rows (member ids 'TEST1000%').
-- To remove the demo data entirely, run just the first batch.

/* ══════════ 1. clear previous demo rows (children first) ══════════ */
DELETE e FROM dbo.tp_tracking_events e JOIN dbo.tp_orders o ON o.id = e.order_id WHERE o.member_key LIKE 'TEST1000%';
DELETE a FROM dbo.tp_getrx_attempts a JOIN dbo.tp_orders o ON o.id = a.order_id WHERE o.member_key LIKE 'TEST1000%';
DELETE c FROM dbo.tp_rts_contacts c JOIN dbo.tp_rts_cases k ON k.id = c.case_id WHERE k.member_key LIKE 'TEST1000%';
DELETE FROM dbo.tp_rts_cases        WHERE member_key LIKE 'TEST1000%';
DELETE FROM dbo.tp_rx_records       WHERE member_key LIKE 'TEST1000%';
DELETE FROM dbo.tp_cypress_requests WHERE member_key LIKE 'TEST1000%';
DELETE FROM dbo.tp_orders           WHERE member_key LIKE 'TEST1000%';
DELETE FROM dbo.tp_enrollment_worksheet WHERE member_key LIKE 'TEST1000%';
DELETE FROM dbo.GLP1_ContactLog     WHERE member_key LIKE 'TEST1000%';
DELETE FROM dbo.tp_review_close     WHERE member_key LIKE 'TEST1000%';
DELETE FROM dbo.tp_member_intakes   WHERE member_key LIKE 'TEST1000%';
DELETE FROM dbo.tp_batch            WHERE customer_id LIKE 'TEST1000%';
DELETE FROM dbo.tp_reminders        WHERE description LIKE '%[DEMO]%';
DELETE FROM dbo.tp_tasks            WHERE name LIKE '%[DEMO]%';
DELETE FROM dbo.ReadyToAssign       WHERE Member_ID LIKE 'TEST1000%' AND Member_ID NOT IN ('TEST100001','TEST100002');
GO

/* ══════════ 2. the demo roster + outreach history (My Queue) ══════════ */
DECLARE @cc INT = 2;                       -- assigned concierge (Laura Chiommino)
DECLARE @today DATE = CAST(GETDATE() AS date);

DECLARE @m TABLE (
  mid VARCHAR(50), first VARCHAR(50), last VARCHAR(50), dob DATE, cat VARCHAR(50),
  drug VARCHAR(50), priority NVARCHAR(20), attempts INT, followup_offset INT, city VARCHAR(50)
);
-- followup_offset: days from today (negative = overdue, 0 = due today, NULL = none)
INSERT INTO @m VALUES
 ('TEST100010','MARIA','RIVERA',   '1971-03-08','GLP1',   'WEGOVY INJ 1MG/0.5ML',    'Urgent', 4,  -9, 'Austin'),
 ('TEST100011','DANIEL','OKONKWO', '1966-11-30','GLP1',   'OZEMPIC INJ 2MG/1.5ML',   'High',   2,  -5, 'Round Rock'),
 ('TEST100012','LINH','NGUYEN',    '1984-07-19','NONGLP1','COSENTYX PEN 150MG',      'High',   3,  -2, 'Pflugerville'),
 ('TEST100013','ARJUN','PATEL',    '1979-01-25','GLP1',   'MOUNJARO INJ 7.5MG/0.5ML','Medium', 1,   0, 'Austin'),
 ('TEST100014','ELENA','SANTOS',   '1990-06-02','GLP1',   'ZEPBOUND INJ 5MG/0.5ML',  'Urgent', 5,   0, 'Cedar Park'),
 ('TEST100015','CONNOR','WALSH',   '1988-09-14','GLP1',   'TRULICITY INJ 1.5MG/0.5ML','Medium',2,   2, 'Austin'),
 ('TEST100016','SARA','ABADI',     '1973-12-05','NONGLP1','DUPIXENT PEN 300MG',      'Low',    1,   4, 'Georgetown'),
 ('TEST100017','PIOTR','KOWALSKI', '1962-04-21','GLP1',   'OZEMPIC INJ 1MG/0.5ML',   'Medium', 3,   6, 'Austin'),
 ('TEST100018','TASHA','FREEMAN',  '1981-08-17','GLP1',   'WEGOVY INJ 2.4MG/0.75ML', 'High',   6, NULL,'Leander'),
 ('TEST100019','HEIDI','BRANDT',   '1995-02-11','GLP1',   'MOUNJARO INJ 2.5MG/0.5ML','Low',    0, NULL,'Austin'),
 -- for the Review & Close recycling queue
 ('TEST100020','WEI','CHEN',       '1968-10-03','GLP1',   'OZEMPIC INJ 1MG/0.5ML',   'Low',    6, NULL,'Austin'),
 ('TEST100021','JUAN','MORALES',   '1977-05-28','NONGLP1','HUMIRA PEN 40MG/0.8ML',   'Medium', 3, NULL,'Kyle');

INSERT INTO dbo.ReadyToAssign
  (category, Group_Code, Group_Name, Member_ID, Claim_Patient_ID, Last_Name, First_Name,
   Date_of_Birth, Gender, Address, City, State, Zip_Code, Date_of_Service, NDC, Drug_Name,
   Fill_Number, Quantity_Dispensed, Days_Supply, Pharmacy_Name, status, assigned_to, assigned_by, assigned_at)
SELECT m.cat, 'TPTEST', 'TruePath Test Group', m.mid, m.mid, m.last, m.first,
       m.dob, CASE WHEN m.first IN ('MARIA','LINH','ELENA','SARA','TASHA','HEIDI') THEN 'F' ELSE 'M' END,
       '100 Demo St', m.city, 'TX', '78701',
       DATEADD(day, -30, @today), '00169-4132-12', m.drug,
       '1', '2', '30', 'DEMO PHARMACY', 'Assigned', @cc, @cc, DATEADD(day, -20, GETDATE())
FROM @m m;

INSERT INTO dbo.tp_member_intakes (member_key, intake_type, status, status_date, priority, updated_by)
SELECT m.mid, m.cat, 'In Progress', DATEADD(day, -20, @today), m.priority, @cc FROM @m m;

-- The clear-down above removes intakes for every TEST1000% member, including the
-- two originals (TEST100001/2) whose ReadyToAssign rows are deliberately kept.
-- Rebuild an intake for any preserved demo member+category that now lacks one,
-- so a member holding both a GLP-1 and a non-GLP-1 track still demonstrates that.
INSERT INTO dbo.tp_member_intakes (member_key, intake_type, status, status_date, priority, updated_by)
SELECT DISTINCT r.Member_ID, r.category, 'In Progress', DATEADD(day, -20, @today), 'Medium', @cc
FROM dbo.ReadyToAssign r
WHERE r.Member_ID IN ('TEST100001','TEST100002')
  AND NOT EXISTS (SELECT 1 FROM dbo.tp_member_intakes mi
                  WHERE mi.member_key = r.Member_ID AND mi.intake_type = r.category);

-- Outreach history: earlier attempts Closed, the latest Open carrying the follow-up
-- date, which is what My Queue reads for Overdue / Due Today.
DECLARE @mid VARCHAR(50), @cat VARCHAR(50), @n INT, @off INT, @i INT, @cd DATE;
DECLARE c CURSOR FOR SELECT mid, cat, attempts, followup_offset FROM @m WHERE attempts > 0;
OPEN c; FETCH NEXT FROM c INTO @mid, @cat, @n, @off;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @i = 1;
  WHILE @i <= @n
  BEGIN
    SET @cd = DATEADD(day, -3 * (@n - @i) + ISNULL(@off, 0) - 3, @today);
    INSERT INTO dbo.GLP1_ContactLog
      (member_key, category, contact_date, contact_type, notes, followup_date, contact_status, created_by, outreach_attempt)
    VALUES (@mid, @cat, @cd,
      CASE WHEN @i IN (1,3) THEN 'Phone Call' WHEN @i = 5 THEN 'Email' ELSE 'Text' END,
      CASE WHEN @i = 1 THEN 'Attempt 1 — Call + Voicemail — no answer, left voicemail'
           WHEN @i = 2 THEN 'Attempt 2 — Text — delivered, no reply'
           WHEN @i = 3 THEN 'Attempt 3 — Call + Voicemail + Text (booking link) — no answer'
           WHEN @i = 4 THEN 'Attempt 4 — Text / Email (booking link) — no reply'
           WHEN @i = 5 THEN 'Attempt 5 — Email (booking link) — no reply'
           ELSE 'Attempt 6 — Final outreach (booking link) — no reply' END,
      CASE WHEN @i = @n AND @off IS NOT NULL THEN DATEADD(day, @off, @today) END,
      CASE WHEN @i = @n AND @off IS NOT NULL THEN 'Open' ELSE 'Closed' END,
      @cc, @i);
    SET @i = @i + 1;
  END
  FETCH NEXT FROM c INTO @mid, @cat, @n, @off;
END
CLOSE c; DEALLOCATE c;

-- Members who used all six attempts route to Review & Close.
INSERT INTO dbo.tp_review_close (member_key, intake_type, reason, status, routed_by)
SELECT m.mid, m.cat, 'Non-Responsive (6 attempts)', 'Open', NULL FROM @m m WHERE m.attempts >= 6;

-- Morales reached invalid contact details on every attempt: RC2 marks that
-- Invalid Information after 3 and routes to Review & Close.
UPDATE dbo.GLP1_ContactLog SET invalid_contact = 1 WHERE member_key = 'TEST100021';
INSERT INTO dbo.tp_review_close (member_key, intake_type, reason, status, routed_by)
VALUES ('TEST100021', 'NONGLP1', 'Invalid Information (3 attempts)', 'Open', NULL);

-- Chen has already been reviewed and closed for recycling; Morales is flagged
-- but not yet closed, so the recycling queue shows both states.
UPDATE dbo.tp_member_intakes SET outreach_status='Non-Responsive', outreach_status_at=SYSUTCDATETIME(),
       recycle_after = DATEADD(day, 21, CAST(GETDATE() AS date)), ticket_status='Closed'
 WHERE member_key='TEST100020';
UPDATE dbo.tp_review_close SET status='Recycled', close_reason='Non-Responsive',
       close_detail='CLOSED due to unresponsiveness after all outreach attempts were made.',
       member_status='Non-Responsive', resolved_at=SYSUTCDATETIME()
 WHERE member_key='TEST100020';

UPDATE dbo.tp_member_intakes SET outreach_status='Invalid Information', outreach_status_at=SYSUTCDATETIME()
 WHERE member_key='TEST100021';
GO

/* ══════════ 3. orders across the fulfillment pipeline ══════════ */
DECLARE @cc INT = 2, @today DATE = CAST(GETDATE() AS date);

DECLARE @o TABLE (
  mid VARCHAR(50), cat VARCHAR(50), med NVARCHAR(200), strength NVARCHAR(100), ds INT,
  stage NVARCHAR(40), getrx NVARCHAR(40), prio NVARCHAR(20), addr BIT,
  carrier NVARCHAR(60), tn NVARCHAR(120), shipped_off INT, delivered_off INT,
  confirmed BIT, delay BIT, runout_off INT, batch BIT
);
INSERT INTO @o VALUES
 -- prescriber chase in progress
 ('TEST100010','GLP1','Semaglutide','1mg',30,'Get Rx','Follow-up Call','Urgent',0,NULL,NULL,NULL,NULL,0,0,60,0),
 -- Rx just received, being processed
 ('TEST100014','GLP1','Tirzepatide','5mg',30,'Rx Received','Rx Received','Urgent',0,NULL,NULL,NULL,NULL,0,0,55,0),
 -- awaiting address verification
 ('TEST100017','GLP1','Semaglutide','1mg',90,'Processing','Rx Received','Medium',0,NULL,NULL,NULL,NULL,0,0,75,0),
 -- handed to procurement, awaiting shipment
 ('TEST100013','GLP1','Tirzepatide','7.5mg',90,'Ordered','Rx Received','Medium',1,NULL,NULL,NULL,NULL,0,0,80,1),
 -- in transit, member texted
 ('TEST100015','GLP1','Dulaglutide','1.5mg',30,'Shipped','Rx Received','Medium',1,'USPS','9400111899223197428490',-4,NULL,0,0,45,1),
 -- delivered, still needs the confirmation call
 ('TEST100012','NONGLP1','Secukinumab','150mg',30,'Delivered','Rx Received','High',1,'UPS','1Z999AA10123456784',-8,-2,0,0,40,1),
 -- delayed shipment with a delivery-support case (see next batch)
 ('TEST100011','GLP1','Semaglutide','2mg',30,'Shipped','Rx Received','High',1,'USPS','9400111899223197428506',-11,NULL,0,1,50,1);

-- procurement batch rows for anything handed off
INSERT INTO dbo.tp_batch (customer_id, customer_name, drug_name, strength, vendor, vendor_day_supply, status, transaction_date, document_patient_id)
SELECT o.mid, r.Last_Name + ', ' + r.First_Name, o.med, o.strength, 'Cypress', o.ds, 'Pending', DATEADD(day,-14,@today), o.mid
FROM @o o JOIN dbo.ReadyToAssign r ON r.Member_ID = o.mid AND r.category = o.cat WHERE o.batch = 1;

INSERT INTO dbo.tp_orders
  (member_key, intake_type, medication, strength, day_supply, stage, getrx_status, priority,
   address_verified, address_verified_at, batch_id, handed_off_at, carrier, tracking_number,
   shipped_date, tracking_texted_at, last_carrier_status, last_carrier_check, delivered_date,
   delivery_confirmed, delay_flag, delay_notes, run_out_date, rebate_group, rebate_monthly, rebate_annual,
   assigned_to, created_by, created_at, updated_at)
SELECT o.mid, o.cat, o.med, o.strength, o.ds, o.stage, o.getrx, o.prio,
       o.addr, CASE WHEN o.addr = 1 THEN DATEADD(day,-16,GETDATE()) END,
       b.id, CASE WHEN o.batch = 1 THEN DATEADD(day,-14,GETDATE()) END,
       o.carrier, o.tn,
       CASE WHEN o.shipped_off IS NOT NULL THEN DATEADD(day, o.shipped_off, @today) END,
       CASE WHEN o.tn IS NOT NULL THEN DATEADD(day, o.shipped_off, GETDATE()) END,
       CASE WHEN o.delivered_off IS NOT NULL THEN 'Delivered'
            WHEN o.delay = 1 THEN 'Available for pickup at local PO'
            WHEN o.tn IS NOT NULL THEN 'In transit' END,
       CASE WHEN o.tn IS NOT NULL THEN DATEADD(day,-1,GETDATE()) END,
       CASE WHEN o.delivered_off IS NOT NULL THEN DATEADD(day, o.delivered_off, @today) END,
       o.confirmed, o.delay,
       CASE WHEN o.delay = 1 THEN 'Held at local post office — member not reached' END,
       DATEADD(day, o.runout_off, @today),
       CASE WHEN o.batch = 1 THEN 'GLP1-2026' END,
       CASE WHEN o.batch = 1 THEN 75.00 END, CASE WHEN o.batch = 1 THEN 900.00 END,
       @cc, @cc, DATEADD(day,-18,GETDATE()), GETDATE()
FROM @o o
LEFT JOIN dbo.tp_batch b ON b.customer_id = o.mid AND o.batch = 1;

-- Get Rx attempts for the member still chasing a prescriber
INSERT INTO dbo.tp_getrx_attempts (order_id, attempt_no, target, channel, phone_tree, turnaround_days, notes, outcome, followup_date, created_by, created_at)
SELECT o.id, v.n, 'Prescriber', v.ch, v.pt, v.ta, v.notes, v.outcome, DATEADD(day, v.fu, @today), @cc, DATEADD(day, v.cd, GETDATE())
FROM dbo.tp_orders o
CROSS APPLY (VALUES
  (1,'Fax',  NULL,             NULL,'Initial Rx request faxed to prescriber','Faxed',        -6, -9),
  (2,'Call', 'Option 2 – Refills', 5,'Spoke to front desk; promised 5 days',  'LVM / promised',-1, -4)
) v(n, ch, pt, ta, notes, outcome, fu, cd)
WHERE o.member_key = 'TEST100010' AND o.intake_type = 'GLP1';

-- tracking history for shipped / delivered orders
INSERT INTO dbo.tp_tracking_events (order_id, event_type, status, notes, occurred_at, created_by)
SELECT o.id, 'Hand-off', 'Handed to procurement', 'Batch #' + CAST(o.batch_id AS varchar(10)), DATEADD(day,-14,GETDATE()), @cc
FROM dbo.tp_orders o WHERE o.member_key LIKE 'TEST1000%' AND o.batch_id IS NOT NULL;
INSERT INTO dbo.tp_tracking_events (order_id, event_type, status, notes, occurred_at, created_by)
SELECT o.id, 'Shipped', o.carrier + ' ' + o.tracking_number, 'Shipped from Cypress', DATEADD(day,-10,GETDATE()), @cc
FROM dbo.tp_orders o WHERE o.tracking_number IS NOT NULL;
INSERT INTO dbo.tp_tracking_events (order_id, event_type, status, notes, occurred_at, created_by)
SELECT o.id, 'Tracking Texted', 'Prepared [staged]', 'Tracking text sent to member', DATEADD(day,-9,GETDATE()), @cc
FROM dbo.tp_orders o WHERE o.tracking_number IS NOT NULL;
INSERT INTO dbo.tp_tracking_events (order_id, event_type, status, notes, occurred_at, created_by)
SELECT o.id, 'Delivered', 'Delivered', NULL, DATEADD(day,-2,GETDATE()), @cc
FROM dbo.tp_orders o WHERE o.delivered_date IS NOT NULL;
GO

/* ══════════ 4. Rx records (Rx Processing screens) ══════════ */
DECLARE @cc INT = 2, @today DATE = CAST(GETDATE() AS date);

INSERT INTO dbo.tp_rx_records
  (order_id, member_key, intake_type, member_name, dob, medication, strength, written_date,
   status, invalid_reason, day_supply, file_name, label, name_dob_confirmed, dosage_changed,
   created_by, created_at, updated_at)
SELECT o.id, v.mid, v.cat, v.nm, v.dob, v.med, v.str, DATEADD(day, v.wr, @today),
       v.st, v.reason, v.ds,
       v.nm + ' (' + v.dob + ') - ' + v.med + ' ' + v.str + ' - WR ' +
         CONVERT(varchar(10), DATEADD(day, v.wr, @today), 101) + v.suffix,
       v.label, 1, v.dose, @cc, DATEADD(day, v.cd, GETDATE()), GETDATE()
-- `cd` = days ago the Rx was processed. Several are dated TODAY so the daily
-- Rx-processing list (which opens on today) has rows without changing filters.
FROM (VALUES
  ('TEST100014','GLP1','Elena Santos','6/2/1990','Tirzepatide','5mg',   -1,'Valid',              NULL,30,'',                     'Rx - 30 day',        0, 0),
  ('TEST100017','GLP1','Piotr Kowalski','4/21/1962','Semaglutide','1mg',-2,'INVALID','no prescriber signature',NULL,' - INVALID (no prescriber signature)','INVALID - no prescriber signature',0, 0),
  ('TEST100012','NONGLP1','Linh Nguyen','7/19/1984','Secukinumab','300mg',-1,'Valid',            NULL,30,'',                     'Rx - 30 day',        1, 0),
  ('TEST100016','NONGLP1','Sara Abadi','12/5/1973','Dupilumab','300mg', -2,'NEED 90 DAY',        NULL,90,' - NEED 90 DAY',       'NEED 90 DAY - 90 day',0, 0),
  ('TEST100010','GLP1','Maria Rivera','3/8/1971','Semaglutide','1mg',   -4,'DUPLICATE RX',       NULL,NULL,' - DUPLICATE RX',    'DUPLICATE',          0, 0),
  ('TEST100013','GLP1','Arjun Patel','1/25/1979','Tirzepatide','7.5mg', -3,'Valid',              NULL,90,'',                     'Rx - 90 day',        0,-3),
  ('TEST100015','GLP1','Connor Walsh','9/14/1988','Dulaglutide','1.5mg',-12,'Valid',             NULL,30,'',                     'Rx - 30 day',        0,-12),
  ('TEST100012','NONGLP1','Linh Nguyen','7/19/1984','Secukinumab','150mg',-16,'Valid',           NULL,30,'',                     'Rx - 30 day',        0,-16),
  ('TEST100011','GLP1','Daniel Okonkwo','11/30/1966','Semaglutide','2mg',-14,'Valid',            NULL,30,'',                     'Rx - 30 day',        0,-14)
) v(mid, cat, nm, dob, med, str, wr, st, reason, ds, suffix, label, dose, cd)
LEFT JOIN dbo.tp_orders o ON o.member_key = v.mid AND o.intake_type = v.cat;
GO

/* ══════════ 5. delivery-support (RTS) case + Cypress requests ══════════ */
DECLARE @cc INT = 2, @today DATE = CAST(GETDATE() AS date);

-- A day-11 case on the delayed shipment: Week 2 cadence, courtesy hold due soon.
INSERT INTO dbo.tp_rts_cases
  (order_id, member_key, intake_type, issue_category, package_type, medication_type,
   signature_required, hold_start_date, hold_days, status, opened_by, opened_at, updated_at)
SELECT o.id, o.member_key, o.intake_type, 'RTS Escalation', 'Priority Mail Express Intl', 'Refrigerated',
       1, DATEADD(day,-10,@today), 15, 'Open', @cc, DATEADD(day,-10,GETDATE()), GETDATE()
FROM dbo.tp_orders o WHERE o.member_key = 'TEST100011' AND o.delay_flag = 1;

INSERT INTO dbo.tp_rts_contacts (case_id, contact_date, day_no, did_text, did_call, did_email, reached, member_plan, tracking_status, notes, created_by)
SELECT k.id, DATEADD(day, v.d, @today), v.day_no, v.t, v.c, v.e, 0, NULL, v.trk, v.notes, @cc
FROM dbo.tp_rts_cases k
CROSS APPLY (VALUES
  (-3, 8, 1,1,1,'Arrived at local post office','Week 2 — text, call and email sent; no response'),
  (-2, 9, 1,1,1,'Available for pickup',        'Week 2 — no response'),
  (-1,10, 1,1,0,'Available for pickup',        'Text and call done; email still outstanding')
) v(d, day_no, t, c, e, trk, notes)
WHERE k.member_key = 'TEST100011';

-- Cypress requests: a transfer out and a verbal request
INSERT INTO dbo.tp_cypress_requests
  (member_key, intake_type, order_id, request_type, member_name, dob, phone, address, medication, strength,
   pharmacy_name, pharmacy_address, pharmacy_phone, pharmacy_fax, supply_on_hand, never_filled,
   prescriber_name, prescriber_phone, status, notes, created_by, created_at, updated_at)
SELECT v.mid, v.cat, o.id, v.rtype, v.nm, v.dob, v.phone, v.addr, v.med, v.str,
       v.ph_name, v.ph_addr, v.ph_phone, v.ph_fax, v.soh, v.never, v.dr, v.dr_phone, v.st, v.notes,
       @cc, DATEADD(day, v.cd, GETDATE()), GETDATE()
FROM (VALUES
  ('TEST100017','GLP1','Transfer Out','Piotr Kowalski','4/21/1962','512-555-0142','100 Demo St, Austin TX 78701',
   'Semaglutide','1mg','CVS #4821','1400 Main St, Houston TX 77002','713-555-0110','713-555-0111','12 days on hand',0,
   NULL,NULL,'Submitted','Member moving to mail order',-2),
  ('TEST100010','GLP1','Verbal Request','Maria Rivera','3/8/1971','512-555-0163','100 Demo St, Austin TX 78701',
   'Semaglutide','1mg',NULL,NULL,NULL,NULL,NULL,0,
   'Dr. Alan Reyes','512-555-0199','Sent to Cypress','Prescriber unresponsive after 4 attempts',-1)
) v(mid, cat, rtype, nm, dob, phone, addr, med, str, ph_name, ph_addr, ph_phone, ph_fax, soh, never, dr, dr_phone, st, notes, cd)
LEFT JOIN dbo.tp_orders o ON o.member_key = v.mid AND o.intake_type = v.cat;
GO

/* ══════════ what the queues should now show ══════════ */
DECLARE @today DATE = CAST(GETDATE() AS date);
SELECT 'demo members'    AS metric, COUNT(*) AS n FROM dbo.ReadyToAssign WHERE Member_ID LIKE 'TEST1000%'
UNION ALL SELECT 'overdue',   COUNT(*) FROM (SELECT member_key, MIN(followup_date) f FROM dbo.GLP1_ContactLog WHERE contact_status='Open' AND member_key LIKE 'TEST1000%' GROUP BY member_key, category) x WHERE x.f < @today
UNION ALL SELECT 'due today', COUNT(*) FROM (SELECT member_key, MIN(followup_date) f FROM dbo.GLP1_ContactLog WHERE contact_status='Open' AND member_key LIKE 'TEST1000%' GROUP BY member_key, category) y WHERE y.f = @today
UNION ALL SELECT 'review & close', COUNT(*) FROM dbo.tp_review_close WHERE member_key LIKE 'TEST1000%'
UNION ALL SELECT 'orders',    COUNT(*) FROM dbo.tp_orders WHERE member_key LIKE 'TEST1000%'
UNION ALL SELECT 'rx records',COUNT(*) FROM dbo.tp_rx_records WHERE member_key LIKE 'TEST1000%'
UNION ALL SELECT 'rts cases', COUNT(*) FROM dbo.tp_rts_cases WHERE member_key LIKE 'TEST1000%'
UNION ALL SELECT 'cypress',   COUNT(*) FROM dbo.tp_cypress_requests WHERE member_key LIKE 'TEST1000%';
GO
