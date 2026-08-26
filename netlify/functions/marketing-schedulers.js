const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options, CORS } = require('./_auth');
const { sendEmail } = require('./_email');

// Real-time registration notifications go here (in addition to the daily recap).
const SCHEDULER_NOTIFY_TO = process.env.SCHEDULER_NOTIFY_TO || 'onbasesupport@internationalrx.com';

// Marketing › Schedulers — MS Bookings-style appointment tools.
//
// Admin (auth required):
//   GET                 -> list schedulers with booking counts
//   GET    ?appointments=1 -> all bookings across active schedulers (Appointments list)
//   GET    ?concierges=1   -> active Client Concierge users (assignee picker)
//   GET    ?id=X        -> one scheduler + its bookings
//   POST                -> create scheduler
//   PATCH  ?id=X        -> update scheduler
//   DELETE ?id=X        -> delete scheduler (and its bookings)
//
// Public (no auth — shared via the generated URL/QR):
//   GET    ?s=<public_id>  -> scheduler (safe fields) + available slots w/ remaining capacity
//   POST   ?s=<public_id>  -> create a booking (body: { slot_start, name, email, phone, notes })

const SAFE_FIELDS = `id, public_id, name, name_es, description, description_es, location, client_id, client_name, client_company,
  start_date, end_date, day_start_time, day_end_time, interval_minutes,
  capacity_per_slot, days_of_week, active`;

function randomToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 16; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function pad(n) { return String(n).padStart(2, '0'); }

// Local-naive datetime -> 'YYYY-MM-DDTHH:mm:00' (matches how slots are generated below).
function isoLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

// Generate every slot start for a scheduler as an array of 'YYYY-MM-DDTHH:mm:00' strings.
function generateSlots(s) {
  const slots = [];
  const dows = String(s.days_of_week || '').split(',').map(x => parseInt(x, 10)).filter(x => !isNaN(x));
  const [sh, sm] = String(s.day_start_time || '09:00').split(':').map(Number);
  const [eh, em] = String(s.day_end_time || '17:00').split(':').map(Number);
  const interval = Math.max(5, parseInt(s.interval_minutes, 10) || 30);

  const start = new Date(s.start_date);
  const end = new Date(s.end_date);
  // start_date/end_date come back as Date at UTC midnight; read the UTC calendar date.
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

  while (day.getTime() <= last) {
    if (dows.includes(day.getUTCDay())) {
      const y = day.getUTCFullYear(), mo = day.getUTCMonth(), dt = day.getUTCDate();
      let mins = sh * 60 + sm;
      const endMins = eh * 60 + em;
      while (mins + interval <= endMins) {
        const slot = new Date(y, mo, dt, Math.floor(mins / 60), mins % 60);
        slots.push(isoLocal(slot));
        mins += interval;
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return slots;
}

// Registrants must book at least this far ahead. Slots inside the window are hidden by
// the booking page and rejected here. The cutoff is the current time PLUS the buffer,
// expressed as a naive Central wall-clock string to match how slots are generated — so
// a string compare (slot >= cutoff) is a correct "at least 2 hours out" test.
const BOOKING_BUFFER_MS = 2 * 60 * 60 * 1000;
function bookingCutoff() {
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(Date.now() + BOOKING_BUFFER_MS)).forEach((x) => { p[x.type] = x.value; });
  const h = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${h}:${p.minute}:${p.second}`;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const { id, s: slug, booking, concierges, appointments } = event.queryStringParameters || {};

  try {
    // ── Public flow (shared link) ──────────────────────────────────────────
    if (slug) {
      const sr = await mssql(
        `SELECT ${SAFE_FIELDS}, logo_data FROM dbo.Booking_Schedulers WHERE public_id = @slug AND active = 1`,
        { slug });
      const sched = sr.recordset[0];
      if (!sched) return notFound('This scheduler is not available.');

      if (event.httpMethod === 'GET') {
        const counts = await mssql(
          `SELECT slot_start, COUNT(*) AS taken FROM dbo.Bookings
           WHERE scheduler_id = @sid GROUP BY slot_start`, { sid: sched.id });
        const takenBy = {};
        counts.recordset.forEach(r => { takenBy[isoLocal(new Date(r.slot_start))] = r.taken; });

        const cutoff = bookingCutoff();   // 2-hour advance-booking buffer
        const slots = generateSlots(sched)
          .filter(iso => iso >= cutoff)
          .map(iso => ({ start: iso, remaining: Math.max(0, sched.capacity_per_slot - (takenBy[iso] || 0)) }));
        return ok({ scheduler: sched, slots });
      }

      if (event.httpMethod === 'POST') {
        const b = JSON.parse(event.body || '{}');
        const company = (b.company_name || '').trim();
        const first = (b.first_name || '').trim();
        const last = (b.last_name || '').trim();
        const phone = (b.phone || '').trim();
        if (!company) return badRequest('Company name is required.');
        if (!first) return badRequest('First name is required.');
        if (!last) return badRequest('Last name is required.');
        if (!b.dob) return badRequest('Date of birth is required.');
        if (!phone) return badRequest('Phone number is required.');
        if (!b.slot_start) return badRequest('A time slot is required.');

        // Validate the requested slot is real and in the future.
        const valid = generateSlots(sched);
        if (!valid.includes(b.slot_start)) return badRequest('That time slot is not valid.');
        if (b.slot_start < bookingCutoff()) return badRequest('That time is too soon — please choose a slot at least 2 hours from now.');

        // Enforce capacity.
        const c = await mssql(
          `SELECT COUNT(*) AS taken FROM dbo.Bookings WHERE scheduler_id = @sid AND slot_start = @slot`,
          { sid: sched.id, slot: b.slot_start });
        if (c.recordset[0].taken >= sched.capacity_per_slot) return badRequest('Sorry, that time slot is now full.');

        const lang = b.lang === 'es' ? 'es' : 'en';   // which language the booking page was in
        const r = await mssql(
          `INSERT INTO dbo.Bookings
             (scheduler_id, slot_start, name, company_name, first_name, last_name, dob, email, phone, notes, lang)
           OUTPUT INSERTED.id, INSERTED.slot_start
           VALUES (@sid, @slot, @name, @company, @first, @last, @dob, @email, @phone, @notes, @lang)`,
          { sid: sched.id, slot: b.slot_start, name: `${first} ${last}`,
            company, first, last, dob: b.dob,
            email: (b.email || '').trim() || null, phone, notes: (b.notes || '').trim() || null, lang });

        // Notify the OnBase team the moment a registration comes in (fire-and-forget —
        // never block or fail the booker's confirmation on the email).
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const when = String(b.slot_start).replace('T', ' ').slice(0, 16);
        const row = (k, v) => `<tr><td style="padding:3px 14px 3px 0;color:#64748b">${k}</td><td>${v}</td></tr>`;
        const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
          <h2 style="color:#0d7d74;margin:0 0 10px">New scheduler registration</h2>
          <table style="border-collapse:collapse;font-size:14px">
            ${row('Scheduler', `<b>${esc(sched.name)}</b>`)}
            ${row('Appointment', esc(when))}
            ${row('Name', `${esc(first)} ${esc(last)}`)}
            ${row('Company', esc(company))}
            ${row('Date of Birth', esc(b.dob))}
            ${row('Phone', esc(phone))}
            ${row('Email', esc(b.email) || '&mdash;')}
            ${row('Language', lang === 'es'
              ? '<b style="color:#b45309">Spanish (Español) &mdash; Spanish-speaking</b>'
              : 'English')}
          </table></div>`;
        sendEmail({ to: SCHEDULER_NOTIFY_TO, subject: `New registration: ${first} ${last} — ${sched.name}`, html })
          .catch(() => { /* notification best-effort; booking already saved */ });

        return created(r.recordset[0]);
      }

      return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
    }

    // ── Admin flow (auth required) ─────────────────────────────────────────
    const user = verifyToken(event);
    if (!user) return unauthorized();

    if (event.httpMethod === 'GET') {
      // Active Client Concierge users — used to populate the booking "Assigned To" picker.
      if (concierges) {
        const r = await mssql(
          `SELECT id, LTRIM(RTRIM(CONCAT(firstname, ' ', lastname))) AS name
           FROM dbo.Users
           WHERE active = 1 AND role = 'Client Concierge'
           ORDER BY firstname, lastname`);
        return ok(r.recordset);
      }
      // All bookings across every ACTIVE scheduler — the Marketing › Appointments list.
      if (appointments) {
        const r = await mssql(
          `SELECT bk.id, bk.slot_start, bk.name, bk.company_name, bk.first_name, bk.last_name,
                  bk.dob, bk.email, bk.phone, bk.notes, bk.created_at, bk.assigned_to,
                  LTRIM(RTRIM(CONCAT(u.firstname, ' ', u.lastname))) AS assigned_name,
                  s.id AS scheduler_id, s.name AS scheduler_name, s.client_name
           FROM dbo.Bookings bk
           JOIN dbo.Booking_Schedulers s ON s.id = bk.scheduler_id AND s.active = 1
           LEFT JOIN dbo.Users u ON u.id = bk.assigned_to
           ORDER BY bk.slot_start, bk.created_at`);
        return ok(r.recordset);
      }
      if (id) {
        const sid = parseInt(id, 10);
        const sr = await mssql(`SELECT ${SAFE_FIELDS}, logo_data, created_at, updated_at
          FROM dbo.Booking_Schedulers WHERE id = @sid`, { sid });
        if (!sr.recordset[0]) return notFound();
        const bk = await mssql(
          `SELECT bk.id, bk.slot_start, bk.name, bk.company_name, bk.first_name, bk.last_name,
                  bk.dob, bk.email, bk.phone, bk.notes, bk.created_at, bk.assigned_to,
                  LTRIM(RTRIM(CONCAT(u.firstname, ' ', u.lastname))) AS assigned_name
           FROM dbo.Bookings bk
           LEFT JOIN dbo.Users u ON u.id = bk.assigned_to
           WHERE bk.scheduler_id = @sid ORDER BY bk.slot_start, bk.created_at`, { sid });
        return ok({ ...sr.recordset[0], bookings: bk.recordset });
      }
      const rows = await mssql(
        `SELECT ${SAFE_FIELDS}, s.created_at,
           (SELECT COUNT(*) FROM dbo.Bookings b WHERE b.scheduler_id = s.id) AS booking_count
         FROM dbo.Booking_Schedulers s ORDER BY s.created_at DESC`);
      return ok(rows.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (!b.name) return badRequest('name is required');
      if (!b.start_date || !b.end_date) return badRequest('start_date and end_date are required');
      const r = await mssql(
        `INSERT INTO dbo.Booking_Schedulers
           (public_id, name, name_es, description, description_es, location, client_id, client_name, client_company, logo_data,
            start_date, end_date, day_start_time, day_end_time, interval_minutes,
            capacity_per_slot, days_of_week, active, created_by)
         OUTPUT INSERTED.*
         VALUES (@pub, @name, @nameEs, @desc, @descEs, @loc, @clientId, @clientName, @clientCompany, @logo,
            @start, @end, @dstart, @dend, @interval, @capacity, @dows, @active, @by)`,
        { pub: randomToken(), name: b.name, nameEs: b.name_es || null,
          desc: b.description || null, descEs: b.description_es || null, loc: b.location || null,
          clientId: parseInt(b.client_id, 10) || null, clientName: b.client_name || null,
          clientCompany: b.client_company || null,
          logo: b.logo_data || null,
          start: b.start_date, end: b.end_date,
          dstart: b.day_start_time || '09:00', dend: b.day_end_time || '17:00',
          interval: parseInt(b.interval_minutes, 10) || 30,
          capacity: parseInt(b.capacity_per_slot, 10) || 10,
          dows: b.days_of_week || '1,2,3,4,5',
          active: b.active === false ? 0 : 1, by: user.id || null });
      return created(r.recordset[0]);
    }

    // Assign (or clear) a booking's Client Concierge.
    if (event.httpMethod === 'PATCH' && booking) {
      const bid = parseInt(booking, 10);
      if (!bid) return badRequest('booking id is required');
      const b = JSON.parse(event.body || '{}');
      const assignedTo = parseInt(b.assigned_to, 10) || null;
      const r = await mssql(
        `UPDATE dbo.Bookings
         SET assigned_to = @assignedTo,
             assigned_at = CASE WHEN @assignedTo IS NULL THEN NULL ELSE GETDATE() END
         OUTPUT INSERTED.id, INSERTED.assigned_to WHERE id = @bid`,
        { assignedTo, bid });
      return r.recordset[0] ? ok(r.recordset[0]) : notFound();
    }

    if (event.httpMethod === 'PATCH') {
      const sid = parseInt(id, 10);
      if (!sid) return badRequest('id is required');
      const b = JSON.parse(event.body || '{}');
      // logo_data: omit the key to keep the existing logo; send '' to clear it.
      const setLogo = Object.prototype.hasOwnProperty.call(b, 'logo_data');
      const r = await mssql(
        `UPDATE dbo.Booking_Schedulers
         SET name=@name, name_es=@nameEs, description=@desc, description_es=@descEs,
             location=@loc, client_id=@clientId, client_name=@clientName,
             client_company=@clientCompany,
             ${setLogo ? 'logo_data=@logo,' : ''}
             start_date=@start, end_date=@end,
             day_start_time=@dstart, day_end_time=@dend, interval_minutes=@interval,
             capacity_per_slot=@capacity, days_of_week=@dows, active=@active, updated_at=GETDATE()
         OUTPUT INSERTED.* WHERE id=@sid`,
        { sid, name: b.name, nameEs: b.name_es || null,
          desc: b.description || null, descEs: b.description_es || null, loc: b.location || null,
          clientId: parseInt(b.client_id, 10) || null, clientName: b.client_name || null,
          clientCompany: b.client_company || null,
          ...(setLogo ? { logo: b.logo_data || null } : {}),
          start: b.start_date, end: b.end_date,
          dstart: b.day_start_time || '09:00', dend: b.day_end_time || '17:00',
          interval: parseInt(b.interval_minutes, 10) || 30,
          capacity: parseInt(b.capacity_per_slot, 10) || 10,
          dows: b.days_of_week || '1,2,3,4,5',
          active: b.active === false ? 0 : 1 });
      return r.recordset[0] ? ok(r.recordset[0]) : notFound();
    }

    if (event.httpMethod === 'DELETE') {
      const sid = parseInt(id, 10);
      if (!sid) return badRequest('id is required');
      await mssql('DELETE FROM dbo.Bookings WHERE scheduler_id=@sid', { sid });
      const r = await mssql('DELETE FROM dbo.Booking_Schedulers WHERE id=@sid', { sid });
      return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
