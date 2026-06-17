const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options, CORS } = require('./_auth');

// Marketing › Schedulers — MS Bookings-style appointment tools.
//
// Admin (auth required):
//   GET                 -> list schedulers with booking counts
//   GET    ?id=X        -> one scheduler + its bookings
//   POST                -> create scheduler
//   PATCH  ?id=X        -> update scheduler
//   DELETE ?id=X        -> delete scheduler (and its bookings)
//
// Public (no auth — shared via the generated URL/QR):
//   GET    ?s=<public_id>  -> scheduler (safe fields) + available slots w/ remaining capacity
//   POST   ?s=<public_id>  -> create a booking (body: { slot_start, name, email, phone, notes })

const SAFE_FIELDS = `id, public_id, name, description, location, client_id, client_name,
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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const { id, s: slug } = event.queryStringParameters || {};

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

        const now = new Date();
        const slots = generateSlots(sched)
          .filter(iso => new Date(iso) > now)
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
        if (new Date(b.slot_start) <= new Date()) return badRequest('That time slot has passed.');

        // Enforce capacity.
        const c = await mssql(
          `SELECT COUNT(*) AS taken FROM dbo.Bookings WHERE scheduler_id = @sid AND slot_start = @slot`,
          { sid: sched.id, slot: b.slot_start });
        if (c.recordset[0].taken >= sched.capacity_per_slot) return badRequest('Sorry, that time slot is now full.');

        const r = await mssql(
          `INSERT INTO dbo.Bookings
             (scheduler_id, slot_start, name, company_name, first_name, last_name, dob, email, phone, notes)
           OUTPUT INSERTED.id, INSERTED.slot_start
           VALUES (@sid, @slot, @name, @company, @first, @last, @dob, @email, @phone, @notes)`,
          { sid: sched.id, slot: b.slot_start, name: `${first} ${last}`,
            company, first, last, dob: b.dob,
            email: (b.email || '').trim() || null, phone, notes: (b.notes || '').trim() || null });
        return created(r.recordset[0]);
      }

      return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
    }

    // ── Admin flow (auth required) ─────────────────────────────────────────
    const user = verifyToken(event);
    if (!user) return unauthorized();

    if (event.httpMethod === 'GET') {
      if (id) {
        const sid = parseInt(id, 10);
        const sr = await mssql(`SELECT ${SAFE_FIELDS}, logo_data, created_at, updated_at
          FROM dbo.Booking_Schedulers WHERE id = @sid`, { sid });
        if (!sr.recordset[0]) return notFound();
        const bk = await mssql(
          `SELECT id, slot_start, name, company_name, first_name, last_name, dob, email, phone, notes, created_at
           FROM dbo.Bookings WHERE scheduler_id = @sid ORDER BY slot_start, created_at`, { sid });
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
           (public_id, name, description, location, client_id, client_name, logo_data,
            start_date, end_date, day_start_time, day_end_time, interval_minutes,
            capacity_per_slot, days_of_week, active, created_by)
         OUTPUT INSERTED.*
         VALUES (@pub, @name, @desc, @loc, @clientId, @clientName, @logo,
            @start, @end, @dstart, @dend, @interval, @capacity, @dows, @active, @by)`,
        { pub: randomToken(), name: b.name, desc: b.description || null, loc: b.location || null,
          clientId: parseInt(b.client_id, 10) || null, clientName: b.client_name || null,
          logo: b.logo_data || null,
          start: b.start_date, end: b.end_date,
          dstart: b.day_start_time || '09:00', dend: b.day_end_time || '17:00',
          interval: parseInt(b.interval_minutes, 10) || 30,
          capacity: parseInt(b.capacity_per_slot, 10) || 10,
          dows: b.days_of_week || '1,2,3,4,5',
          active: b.active === false ? 0 : 1, by: user.id || null });
      return created(r.recordset[0]);
    }

    if (event.httpMethod === 'PATCH') {
      const sid = parseInt(id, 10);
      if (!sid) return badRequest('id is required');
      const b = JSON.parse(event.body || '{}');
      // logo_data: omit the key to keep the existing logo; send '' to clear it.
      const setLogo = Object.prototype.hasOwnProperty.call(b, 'logo_data');
      const r = await mssql(
        `UPDATE dbo.Booking_Schedulers
         SET name=@name, description=@desc, location=@loc, client_id=@clientId, client_name=@clientName,
             ${setLogo ? 'logo_data=@logo,' : ''}
             start_date=@start, end_date=@end,
             day_start_time=@dstart, day_end_time=@dend, interval_minutes=@interval,
             capacity_per_slot=@capacity, days_of_week=@dows, active=@active, updated_at=GETDATE()
         OUTPUT INSERTED.* WHERE id=@sid`,
        { sid, name: b.name, desc: b.description || null, loc: b.location || null,
          clientId: parseInt(b.client_id, 10) || null, clientName: b.client_name || null,
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
