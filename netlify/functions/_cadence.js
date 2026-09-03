// RXF1 — status-based follow-up cadence engine.
// Priority drives how many days until the next follow-up per SOP:
//   Low = every 4 days, Medium = every 3, High = every 2, Urgent = every 2.
// Reused by the enrollment-outreach auto-advance now, and by the Get Rx
// prescriber-chase workflow in Phase 3.

const CADENCE_DAYS = { Low: 4, Medium: 3, High: 2, Urgent: 2 };
const PRIORITIES = Object.keys(CADENCE_DAYS);
const ESCALATION_PRIORITIES = ['High', 'Urgent'];

function normalizePriority(p) {
  const hit = PRIORITIES.find(x => x.toLowerCase() === String(p || '').trim().toLowerCase());
  return hit || 'Medium';
}

function cadenceDays(priority) {
  return CADENCE_DAYS[normalizePriority(priority)];
}

// Next follow-up date (YYYY-MM-DD) = from + cadence(priority) days. `from`
// defaults to today; pass a Date or YYYY-MM-DD string.
function nextFollowup(priority, from) {
  const base = from ? new Date(from) : new Date();
  if (isNaN(base)) return null;
  base.setDate(base.getDate() + cadenceDays(priority));
  return base.toISOString().slice(0, 10);
}

function isEscalation(priority) {
  return ESCALATION_PRIORITIES.includes(normalizePriority(priority));
}

module.exports = { CADENCE_DAYS, PRIORITIES, ESCALATION_PRIORITIES, normalizePriority, cadenceDays, nextFollowup, isEscalation };
