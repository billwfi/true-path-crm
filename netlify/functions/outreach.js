const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, serverError, options } = require('./_auth');
const { nextFollowup, normalizePriority, cadenceDays } = require('./_cadence');

// CC1 — 6-attempt enrollment-outreach cadence. Sits on top of the existing
// GLP1_ContactLog (each outreach attempt is a contact row) + tp_member_intakes
// (the intake lifecycle). When the 6th attempt is logged without the member
// progressing past "In Progress", the intake is auto-routed to Review & Close.
//
//   GET  /outreach?member=<key>&category=<type>   -> cadence, attempt state, current script
//   POST /outreach?member=&category=              -> log the next attempt (writes ContactLog, auto-routes on #6)
//   POST /outreach?member=&category=&action=route-review  -> manually route to Review & Close
//
// The member's first name and the booking link are substituted into script_text.

const MAX_ATTEMPTS = 6;

async function loadCadence(cat) {
  // Type-specific cadence if present, else the default '*' cadence.
  const specific = (await mssql(
    `SELECT attempt_no, channel, log_as, booking_link, title, script_text
     FROM dbo.tp_outreach_scripts WHERE intake_type = @c AND active = 1 ORDER BY attempt_no`,
    { c: cat })).recordset;
  if (specific.length) return specific;
  return (await mssql(
    `SELECT attempt_no, channel, log_as, booking_link, title, script_text
     FROM dbo.tp_outreach_scripts WHERE intake_type = '*' AND active = 1 ORDER BY attempt_no`)).recordset;
}

function fillScript(text, ctx) {
  return (text || '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, ctx.first_name || 'there')
    .replace(/\{\{\s*booking_link\s*\}\}/gi, ctx.booking_link || '[booking link]')
    .replace(/\{\{\s*address_link\s*\}\}/gi, ctx.address_link || '[address confirmation link]');
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const q = event.queryStringParameters || {};
  const member = (q.member || '').trim();
  const cat = q.category || 'GLP1';
  if (!member) return badRequest('member is required');
  const booking = process.env.CC_BOOKING_URL || '';
  const addressLink = process.env.CC_ADDRESS_VERIFY_URL || '';

  try {
    // Member first name (for script substitution) from the latest matching claim row.
    const first = (await mssql(
      `SELECT TOP 1 First_Name FROM dbo.ReadyToAssign
       WHERE category = @c AND COALESCE(NULLIF(Member_ID,''), CAST(indx AS VARCHAR(50))) = @m
       ORDER BY indx DESC`, { c: cat, m: member })).recordset[0];
    const ctx = { first_name: (first && first.First_Name) || '', booking_link: booking, address_link: addressLink };

    const cadenceRows = await loadCadence(cat);
    // attempt_no 0 = the address-verification template; the 1-6 cadence is the enrollment sequence.
    const addressStep = cadenceRows.find(s => s.attempt_no === 0) || null;
    const cadence = cadenceRows.filter(s => s.attempt_no >= 1);
    // Only cadence attempts (outreach_attempt not null) count toward the sequence.
    const attempts = (await mssql(
      `SELECT id, contact_date, contact_type, contact_status, notes, outreach_attempt
       FROM dbo.GLP1_ContactLog
       WHERE member_key = @m AND category = @c AND outreach_attempt IS NOT NULL
       ORDER BY outreach_attempt, id`, { m: member, c: cat })).recordset;
    const intake = (await mssql(
      `SELECT status, sub_status, priority FROM dbo.tp_member_intakes WHERE member_key = @m AND intake_type = @c`,
      { m: member, c: cat })).recordset[0] || null;
    const priority = normalizePriority(intake && intake.priority);
    const rc = (await mssql(
      `SELECT status, reason, routed_at FROM dbo.tp_review_close WHERE member_key = @m AND intake_type = @c`,
      { m: member, c: cat })).recordset[0] || null;

    const attemptsLogged = attempts.length;
    const progressed = !!(intake && intake.status && intake.status !== 'In Progress');
    const currentNo = Math.min(attemptsLogged + 1, MAX_ATTEMPTS);
    const exhausted = attemptsLogged >= MAX_ATTEMPTS;

    if (event.httpMethod === 'GET') {
      const currentStep = cadence.find(s => s.attempt_no === currentNo) || null;
      return ok({
        cadence: cadence.map(s => ({
          attempt_no: s.attempt_no, channel: s.channel, log_as: s.log_as,
          booking_link: !!s.booking_link, title: s.title,
          script_text: fillScript(s.script_text, ctx),
        })),
        attempts_logged: attemptsLogged,
        current_attempt: exhausted ? null : currentNo,
        current_step: currentStep ? {
          attempt_no: currentStep.attempt_no, channel: currentStep.channel,
          log_as: currentStep.log_as, booking_link: !!currentStep.booking_link,
          title: currentStep.title, script_text: fillScript(currentStep.script_text, ctx),
        } : null,
        exhausted, progressed,
        max_attempts: MAX_ATTEMPTS,
        booking_configured: !!booking,
        priority,
        cadence_days: cadenceDays(priority),
        next_followup_scheduled: nextFollowup(priority),
        address_link_configured: !!addressLink,
        address_step: addressStep ? {
          channel: addressStep.channel, log_as: addressStep.log_as,
          title: addressStep.title, script_text: fillScript(addressStep.script_text, ctx),
        } : null,
        intake, review_close: rc,
      });
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');

      if (q.action === 'route-review') {
        await routeToReview(member, cat, b.reason || 'Manually routed', user.id);
        return ok({ routed: true, reason: b.reason || 'Manually routed' });
      }

      if (q.action === 'address-verify') {
        // CC2 — staged address-verification text: compose + log it (no live dispatch).
        // Not part of the 1-6 cadence, so outreach_attempt stays NULL.
        const msg = addressStep ? fillScript(addressStep.script_text, ctx)
          : `Hi ${ctx.first_name || 'there'}, please confirm your shipping address: ${ctx.address_link || '[address confirmation link]'}`;
        const row = (await mssql(
          `INSERT INTO dbo.GLP1_ContactLog
             (member_key, category, contact_date, contact_type, notes, followup_date, contact_status, created_by, work_area)
           OUTPUT INSERTED.*
           VALUES (@member, @category, @contact_date, 'Text', @notes, NULL, 'Closed', @by, 'Enrollment Outreach')`,
          { member, category: cat, contact_date: new Date().toISOString().slice(0, 10),
            notes: 'Address verification text prepared [staged]', by: user.id || null })).recordset[0];
        return created({ contact: row, message: msg, staged: true });
      }

      // Log the next outreach attempt.
      if (exhausted) return badRequest('All ' + MAX_ATTEMPTS + ' outreach attempts already logged');
      const step = cadence.find(s => s.attempt_no === currentNo);
      const logAs = (step && step.log_as) || b.contact_type || 'Other';
      const title = (step && step.title) || `Outreach attempt ${currentNo}`;
      const noteBody = (b.notes || '').trim();
      // One-click "send" (staged) marks the scripted message prepared; otherwise a manual log.
      const prefix = b.sent ? `Sent [staged] — ${title}` : title;
      const notes = noteBody ? `${prefix} — ${noteBody}` : prefix;
      // One-click send closes the attempt; a manual log defaults to Open unless told otherwise.
      const status = (b.contact_status === 'Closed' || b.sent) ? 'Closed' : 'Open';
      // Follow-up date: explicit (prescriber turnaround override) wins; else the priority cadence.
      const contactDate = b.contact_date || new Date().toISOString().slice(0, 10);
      const followup = b.followup_date || nextFollowup(priority, contactDate);

      const row = (await mssql(
        `INSERT INTO dbo.GLP1_ContactLog
           (member_key, category, contact_date, contact_type, notes, followup_date, contact_status, created_by, outreach_attempt, invalid_contact, work_area)
         OUTPUT INSERTED.*
         VALUES (@member, @category, @contact_date, @contact_type, @notes, @followup_date, @contact_status, @by, @attempt, @invalid, 'Enrollment Outreach')`,
        {
          member, category: cat, contact_date: contactDate,
          contact_type: logAs, notes,
          followup_date: followup, contact_status: status, by: user.id || null, attempt: currentNo,
          invalid: b.invalid_contact ? 1 : 0,
        })).recordset[0];

      // Ensure the intake record exists (started when assigned; guard for older data).
      await mssql(
        `IF NOT EXISTS (SELECT 1 FROM dbo.tp_member_intakes WHERE member_key=@member AND intake_type=@category)
           INSERT INTO dbo.tp_member_intakes (member_key, intake_type, status, status_date, updated_by)
           VALUES (@member, @category, 'In Progress', CAST(GETDATE() AS DATE), @by)`,
        { member, category: cat, by: user.id || null });

      // RC2 — three or more attempts against bad contact details marks the member
      // "Invalid Information" (for reporting) and sends them to Review & Close,
      // without waiting for the full six-attempt sequence.
      let invalidInfo = false;
      if (b.invalid_contact) {
        const bad = (await mssql(
          `SELECT COUNT(*) n FROM dbo.GLP1_ContactLog
           WHERE member_key=@m AND category=@c AND invalid_contact=1`, { m: member, c: cat })).recordset[0].n;
        if (bad >= 3 && !progressed) {
          await mssql(
            `UPDATE dbo.tp_member_intakes SET outreach_status='Invalid Information',
               outreach_status_at=SYSUTCDATETIME(), updated_by=@by, updated_at=GETDATE()
             WHERE member_key=@m AND intake_type=@c`, { m: member, c: cat, by: user.id || null });
          await routeToReview(member, cat, `Invalid Information (${bad} attempts)`, null);
          invalidInfo = true;
        }
      }

      // Auto-route to Review & Close when the final attempt is logged and the
      // member hasn't progressed past "In Progress".
      let autoRouted = false;
      if (currentNo >= MAX_ATTEMPTS && !progressed) {
        await routeToReview(member, cat, `Non-Responsive (${MAX_ATTEMPTS} attempts)`, null);
        await mssql(
          `UPDATE dbo.tp_member_intakes SET outreach_status=COALESCE(outreach_status,'Non-Responsive'),
             outreach_status_at=SYSUTCDATETIME(), updated_at=GETDATE()
           WHERE member_key=@m AND intake_type=@c`, { m: member, c: cat });
        autoRouted = true;
      }
      return created({ contact: row, attempt_no: currentNo, followup_date: followup,
        next_attempt: currentNo < MAX_ATTEMPTS ? currentNo + 1 : null,
        auto_routed_to_review: autoRouted || invalidInfo,
        invalid_information: invalidInfo });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

// Upsert an Open Review & Close routing for this member+intake. routed_by NULL = auto.
async function routeToReview(member, cat, reason, byUserId) {
  await mssql(
    `MERGE dbo.tp_review_close AS t
     USING (SELECT @member AS member_key, @category AS intake_type) AS s
     ON t.member_key = s.member_key AND t.intake_type = s.intake_type
     WHEN MATCHED AND t.status <> 'Open' THEN
       UPDATE SET status='Open', reason=@reason, routed_by=@by, routed_at=SYSUTCDATETIME(),
                  resolved_by=NULL, resolved_at=NULL
     WHEN NOT MATCHED THEN
       INSERT (member_key, intake_type, reason, status, routed_by)
       VALUES (@member, @category, @reason, 'Open', @by);`,
    { member, category: cat, reason: (reason || '').slice(0, 200), by: byUserId || null });
}
