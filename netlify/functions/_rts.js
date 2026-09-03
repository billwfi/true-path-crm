// TRK1 — RTS prevention rules engine (package delivery support SOP).
// Pure functions: given a case + its contact log, work out what today requires.

// SOP hold table — drives the RTS countdown and when escalations fire.
const PACKAGE_TYPES = {
  'Priority Mail Express Intl': { hold_days: 15, signature_required: true },
  'Parcel Select':              { hold_days: 30, signature_required: false },
  'First Class':                { hold_days: 30, signature_required: false },
};
// Courtesy-hold extension depends on what's in the box.
const COURTESY_EXTENSION = { Refrigerated: 7, Ambient: 14 };
const ISSUE_CATEGORIES = ['RTS Escalation', 'Customs Escalation', 'Invalid Address'];
// SOP §12 — every case must carry these before it can be closed.
const DOC_REQUIREMENTS = [
  { key: 'daily_log',       label: 'Daily log of attempts, actions and reasoning' },
  { key: 'member_comms',    label: 'Timestamped member communication attempts' },
  { key: 'service_request', label: 'USPS Service Request number(s) recorded' },
  { key: 'carrier_records', label: 'Carrier interaction records (agent emails / call notes)' },
  { key: 'tracking_checks', label: 'Tracking status checks logged' },
  { key: 'outcome',         label: 'Final outcome / resolution documented' },
];

const iso = d => new Date(d).toISOString().slice(0, 10);
function toUTCDate(v) {
  if (v instanceof Date) return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  return new Date(String(v).slice(0, 10) + 'T00:00:00Z');
}
function addDays(v, n) { const x = toUTCDate(v); x.setUTCDate(x.getUTCDate() + n); return x; }
function daysBetween(a, b) { return Math.round((toUTCDate(b) - toUTCDate(a)) / 86400000); }

function packageRule(packageType) {
  return PACKAGE_TYPES[packageType] || null;
}

// Day 1 = hold_start_date. Returns 0 when the countdown hasn't started.
function dayNumber(c, today) {
  if (!c.hold_start_date) return 0;
  return daysBetween(c.hold_start_date, today || new Date()) + 1;
}

// Deadline = hold_start + hold_days + any granted courtesy extension.
function holdDeadline(c) {
  if (!c.hold_start_date || !c.hold_days) return null;
  return iso(addDays(c.hold_start_date, (c.hold_days || 0) + (c.hold_extension_days || 0)));
}

// The heart of the SOP: which channels are required today, and why.
//   Week 1 (days 1-7)  : Text + Call daily
//   Week 2 (days 8-15+): Text + Call + Email daily
//   An actionable member plan or a scheduled redelivery suppresses the daily
//   requirement until the plan date; on the plan date the member must be notified
//   that morning. If the plan date passes unresolved, the plan has FAILED and the
//   case escalates immediately to Week 2 contact level regardless of day number.
//   Invalid Address = immediate RTS, no hold period, so no daily cadence.
function requirementFor(c, contacts, todayArg) {
  const today = iso(todayArg || new Date());
  const day = dayNumber(c, today);
  const logged = (contacts || []).find(x => iso(x.contact_date) === today) || null;

  if (c.status && c.status !== 'Open') {
    return { day, level: 'none', channels: [], reason: `Case is ${c.status}`, satisfied: true, logged };
  }
  if (c.issue_category === 'Invalid Address') {
    return { day, level: 'invalid-address', channels: [],
      reason: 'Invalid Address — immediate RTS, no hold period. Correct the address and arrange a reship.',
      satisfied: true, logged };
  }

  // Has an active plan failed? (plan date in the past and the case still open)
  const planFailed = !!(c.plan_active && c.plan_date && iso(c.plan_date) < today);
  // Plan still pending — daily contact suppressed until the plan date.
  if (c.plan_active && c.plan_date && iso(c.plan_date) > today) {
    return { day, level: 'plan-hold', channels: [],
      reason: `Daily contact suppressed — ${c.plan_source === 'Scheduled Redelivery' ? 'redelivery scheduled' : 'member plan'} for ${iso(c.plan_date)}.`,
      plan_date: iso(c.plan_date), satisfied: true, logged };
  }
  // The morning of the plan — notify the member.
  if (c.plan_active && c.plan_date && iso(c.plan_date) === today) {
    const done = !!(logged && (logged.did_text || logged.did_call || logged.did_email));
    return { day, level: 'plan-day', channels: ['Text'],
      reason: 'Plan date is today — notify the member this morning.',
      plan_date: today, satisfied: done, logged };
  }

  // Week 1 / Week 2 cadence (a failed plan jumps straight to Week 2).
  const week2 = planFailed || day >= 8;
  const channels = week2 ? ['Text', 'Call', 'Email'] : ['Text', 'Call'];
  // SQL bits arrive as 0/1, so coerce the result to a real boolean.
  const satisfied = !!(logged
    && (!channels.includes('Text')  || logged.did_text)
    && (!channels.includes('Call')  || logged.did_call)
    && (!channels.includes('Email') || logged.did_email));
  const reason = planFailed
    ? 'Member plan failed — escalated to Week 2 contact level (Text + Call + Email daily).'
    : week2
      ? `Day ${day} — Week 2: Text + Call + Email required daily.`
      : `Day ${day} — Week 1: Text + Call required daily.`;
  return { day, level: week2 ? 'week2' : 'week1', channels, reason, satisfied, plan_failed: planFailed, logged };
}

// Courtesy hold is requested on days 12-13, at the local office only.
function courtesyHold(c, today) {
  const day = dayNumber(c, today);
  const ext = COURTESY_EXTENSION[c.medication_type] || null;
  const due = day >= 12 && day <= 13 && !c.courtesy_hold_requested && c.issue_category !== 'Invalid Address';
  const overdue = day > 13 && !c.courtesy_hold_requested && c.issue_category !== 'Invalid Address';
  return {
    due, overdue, day, extension_days: ext,
    label: ext ? `${ext} day${ext === 1 ? '' : 's'} (${c.medication_type})` : null,
    text: ext ? (c.medication_type === 'Refrigerated' ? '1 additional week' : '2 additional weeks') : null,
    requested: !!c.courtesy_hold_requested,
  };
}

function docStatus(c) {
  let saved = {};
  try { saved = c.doc_checklist ? JSON.parse(c.doc_checklist) : {}; } catch { saved = {}; }
  const items = DOC_REQUIREMENTS.map(r => ({ ...r, done: !!saved[r.key] }));
  return { items, complete: items.every(i => i.done), missing: items.filter(i => !i.done).map(i => i.label) };
}

module.exports = {
  PACKAGE_TYPES, COURTESY_EXTENSION, ISSUE_CATEGORIES, DOC_REQUIREMENTS,
  packageRule, dayNumber, holdDeadline, requirementFor, courtesyHold, docStatus,
  iso, addDays, daysBetween,
};
