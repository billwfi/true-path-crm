// RCS1 — rebate rules from the Review & Close Guide.
// Pure functions so the SOP maths is testable and lives in one place.

// Only these three statuses are valid per the SOP.
const REBATE_STATUSES = ['UNPAID', 'MAXED OUT', 'N/A'];
// A member maxes out at 4 rebates; R&C raises an Issue Rebate task below that.
const MAX_REBATES = 4;
// Placeholder transaction dates the SOP mandates when a shipment never landed.
const PLACEHOLDER_DATES = { RTS: '2099-01-11', CUSTOMS: '2099-12-31' };
// Standard rebate when no drug-specific rule applies.
const DEFAULT_PER_30 = null;   // unknown — the reviewer enters it

const CLOSE_REASONS = [
  'Enrolled and Ordering',
  'Lack of Response',
  'Non-Responsive',
  'Invalid Information',
  'Opted Out',
  'TERMED per AMT',
  'Profile Status',
  'Other',
];
// Reasons that are outside the usual procedure always need a named authoriser.
const REASONS_NEEDING_AUTH = ['TERMED per AMT', 'Profile Status', 'Other'];

const MEMBER_STATUSES = ['Non-Responsive', 'Invalid Information', 'Opted Out', 'Enrolled and Ordering'];
const TICKET_STATUSES = ['Open', 'In Progress', 'Answered', 'Closed'];

// The SOP's Issue Rebate close-out bubbles.
const REBATE_CHECKLIST = [
  { key: 'amount_confirmed',  label: 'Monthly rebate amount confirmed' },
  { key: 'transaction',       label: 'Transaction / order number recorded' },
  { key: 'tracking',          label: 'All tracking numbers listed (US & international)' },
  { key: 'rebate_address',    label: 'Rebate address confirmed' },
  { key: 'proof_of_delivery', label: 'Proof of delivery attached' },
];
// The SOP's enrollment close-out checklist.
const CLOSE_CHECKLIST = [
  { key: 'checklist_complete', label: 'All ticket checklist items complete' },
  { key: 'reminders_cleared',  label: 'All reminders cleared' },
  { key: 'status_set',         label: 'Profile status set' },
  { key: 'reason_documented',  label: 'Closure reason documented (why + who)' },
];

const norm = s => String(s || '').trim().toUpperCase();

// Resolve a drug to its rule, following biosimilar → reference-brand mapping.
function findRule(drug, rules) {
  const d = norm(drug);
  if (!d) return null;
  const list = rules || [];
  // exact match, else the first rule whose name appears in the drug string
  return list.find(r => norm(r.drug) === d)
      || list.find(r => d.includes(norm(r.drug)))
      || null;
}

// Work out the rebate for one fill.
//   { amount, monthly, rule, ineligible, reason, errors }
// MRC accounts are rebate-ineligible; Tirzepatide is 30-day only; biosimilars
// pay $150 per 30 days and count as a new medication.
function calcRebate({ drug, day_supply, is_mrc, rules }) {
  const out = { amount: null, monthly: null, rule: null, ineligible: false, reason: null, errors: [] };
  if (is_mrc) {
    out.ineligible = true;
    out.reason = 'MRC account — rebates are not issued';
    return out;
  }
  const ds = day_supply == null || day_supply === '' ? null : parseInt(day_supply, 10);
  const rule = findRule(drug, rules);
  if (!rule) {
    out.reason = 'No drug-specific rule — enter the rebate amount manually';
    return out;
  }
  out.rule = rule.notes || rule.drug;
  if (rule.max_day_supply && ds && ds > rule.max_day_supply) {
    out.errors.push(`${rule.drug} is ${rule.max_day_supply}-day supply only (got ${ds})`);
    return out;
  }
  const per30 = rule.amount_per_30 == null ? DEFAULT_PER_30 : Number(rule.amount_per_30);
  if (per30 == null) { out.reason = 'No amount configured for this drug'; return out; }
  out.monthly = per30;
  // Pay per 30-day block; a 90-day fill pays three months.
  const months = ds ? Math.max(1, Math.round(ds / 30)) : 1;
  out.amount = +(per30 * months).toFixed(2);
  if (rule.is_biosimilar) out.reason = 'Biosimilar — counts as a new medication';
  return out;
}

// SOP gate: a rebate task cannot be raised until the transaction date is verified,
// with the mandated placeholder dates for shipments that never arrived.
function transactionDateGate({ transaction_date, shipment_state, aub_number, aub_required }) {
  const errors = [];
  const want = shipment_state === 'RTS' ? PLACEHOLDER_DATES.RTS
             : shipment_state === 'Customs' ? PLACEHOLDER_DATES.CUSTOMS
             : null;
  if (!transaction_date) errors.push('Transaction Date is required before creating the rebate task');
  else if (want && String(transaction_date).slice(0, 10) !== want) {
    errors.push(`${shipment_state === 'RTS' ? 'Returned-to-sender' : 'Stuck-in-customs'} shipments must use transaction date ${want}`);
  }
  if (aub_required && !String(aub_number || '').trim()) errors.push('AUB # is required for this shipment');
  return { ok: errors.length === 0, errors, expected_date: want };
}

// R&C raises an Issue Rebate task while the member is under the cap.
function rebateDue(rebatesIssued) {
  const n = Number(rebatesIssued || 0);
  return { due: n < MAX_REBATES, issued: n, remaining: Math.max(0, MAX_REBATES - n), maxed: n >= MAX_REBATES };
}

// Closure validation: standardized reason, plus WHO when out of procedure.
function validateClose({ close_reason, close_detail, authorized_by, member_status, checklist }) {
  const errors = [];
  if (!CLOSE_REASONS.includes(close_reason)) errors.push('Select a standardized close reason');
  if (!String(close_detail || '').trim()) errors.push('Document why this is being closed');
  if (REASONS_NEEDING_AUTH.includes(close_reason) && !String(authorized_by || '').trim()) {
    errors.push(`"${close_reason}" is out of the usual procedure — record who authorised it (AMT / BA / Procurement)`);
  }
  if (!MEMBER_STATUSES.includes(member_status)) errors.push('Set the member profile status');
  const c = checklist || {};
  const missing = CLOSE_CHECKLIST.filter(i => !c[i.key]).map(i => i.label);
  if (missing.length) errors.push('Close-out checklist incomplete: ' + missing.join('; '));
  return { ok: errors.length === 0, errors };
}

// RC2: three or more outreach attempts against bad contact details.
function invalidInfoEligible(attempts) { return Number(attempts || 0) >= 3; }

module.exports = {
  REBATE_STATUSES, MAX_REBATES, PLACEHOLDER_DATES, CLOSE_REASONS, REASONS_NEEDING_AUTH,
  MEMBER_STATUSES, TICKET_STATUSES, REBATE_CHECKLIST, CLOSE_CHECKLIST,
  findRule, calcRebate, transactionDateGate, rebateDue, validateClose, invalidInfoEligible,
};
