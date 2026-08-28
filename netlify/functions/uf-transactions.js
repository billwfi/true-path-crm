const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, serverError, options } = require('./_auth');

// Invoices › Transactions — read the Unifeyed transactions staged in
// dbo.tp_uf_transactions and log payments against them (dbo.tp_uf_transaction_payments).
//   GET  ?resource=summary[&group=G]          -> { txns, matched, groups, amount, paid }
//   GET  ?resource=groups                     -> distinct groups (+ txn count / amount / name)
//   GET  ?resource=payments&transaction_id=T  -> payment rows for one transaction
//   GET  [&group&status&paid&matched&search]  -> transactions (TOP 500) with paid + balance
//   POST ?resource=payment                    -> log a payment { transaction_id, amount, ... }
//   DELETE ?resource=payment&id=              -> remove a logged payment

const PAID_SUB = `(SELECT transaction_id, SUM(amount) paid, COUNT(*) cnt
                   FROM dbo.tp_uf_transaction_payments GROUP BY transaction_id)`;

// date_ordered_d is the pre-parsed, indexed DATE of date_ordered (populated at load).
// "last N days" relative to the most recent transaction in the current group scope.
const DAYS_CLAUSE = (a) =>
  `(@days IS NULL OR ${a}date_ordered_d >= DATEADD(day, -@days,
     (SELECT MAX(date_ordered_d) FROM dbo.tp_uf_transactions WHERE (@group IS NULL OR group_id=@group))))`;
const daysParam = (d) => (d && d !== 'all' && parseInt(d, 10) > 0 ? parseInt(d, 10) : null);

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { resource, id, transaction_id, group, status, paid, matched, search, days, resolved } =
    event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      // ── Summary tiles ────────────────────────────────────────────────────────
      if (resource === 'summary') {
        const r = (await mssql(
          `SELECT COUNT(*) txns,
                  SUM(CASE WHEN t.resolved_group_pk IS NOT NULL THEN 1 ELSE 0 END) resolved,
                  COUNT(DISTINCT t.tp_group_id) tp_groups,
                  SUM(CASE WHEN t.matches_eligibility=1 THEN 1 ELSE 0 END) matched,
                  COUNT(DISTINCT t.group_id) groups,
                  ISNULL(SUM(t.amount),0) amount,
                  ISNULL((SELECT SUM(pp.amount) FROM dbo.tp_uf_transaction_payments pp
                          WHERE pp.transaction_id IN (SELECT t2.id FROM dbo.tp_uf_transactions t2
                                WHERE (@group IS NULL OR t2.group_id=@group) AND ${DAYS_CLAUSE('t2.')})),0) paid
           FROM dbo.tp_uf_transactions t
           WHERE (@group IS NULL OR t.group_id=@group) AND ${DAYS_CLAUSE('t.')}`,
          { group: group || null, days: daysParam(days) })).recordset[0];
        return ok(r);
      }

      // ── Group filter list (with a friendly name from eligibility) ─────────────
      if (resource === 'groups') {
        const r = (await mssql(
          `SELECT t.group_id, MAX(t.raw_group_id) raw_group_id,
                  MAX(CAST(t.matches_eligibility AS int)) matched,
                  COUNT(*) txns, ISNULL(SUM(t.amount),0) amount,
                  MAX(t.resolved_company) group_name, MAX(t.tp_group_id) tp_group_id
           FROM dbo.tp_uf_transactions t
           WHERE t.group_id IS NOT NULL
           GROUP BY t.group_id
           ORDER BY amount DESC`)).recordset;
        return ok(r);
      }

      // ── Payments for one transaction ──────────────────────────────────────────
      if (resource === 'payments') {
        const tid = parseInt(transaction_id, 10);
        if (!tid) return badRequest('transaction_id required');
        const r = (await mssql(
          `SELECT id, amount, paid_date, method, reference, note, created_by, created_at
           FROM dbo.tp_uf_transaction_payments WHERE transaction_id=@tid
           ORDER BY paid_date DESC, id DESC`, { tid })).recordset;
        return ok(r);
      }

      // ── Transaction list (filtered) ───────────────────────────────────────────
      const r = (await mssql(
        `SELECT TOP 500 t.id, t.source_id, t.order_number, t.transaction_number,
                t.patient_first, t.patient_last, t.cardholder_id, t.member_id,
                t.group_id, t.raw_group_id, t.matches_eligibility,
                t.tp_group_id, t.resolved_company, t.resolved_pbm_id, t.resolved_group_pk,
                t.drug, t.strength, t.reporting_qty, t.reporting_unit,
                t.amount, t.status, t.order_status, t.date_ordered, t.shipped_date,
                ISNULL(p.paid,0) paid, (ISNULL(t.amount,0)-ISNULL(p.paid,0)) balance,
                ISNULL(p.cnt,0) payment_count
         FROM dbo.tp_uf_transactions t
         LEFT JOIN ${PAID_SUB} p ON p.transaction_id=t.id
         WHERE (@group IS NULL OR t.group_id=@group)
           AND (@status IS NULL OR t.status=@status)
           AND (@matched IS NULL OR t.matches_eligibility=@matched)
           AND (@resolved IS NULL
                OR (@resolved='1' AND t.resolved_group_pk IS NOT NULL)
                OR (@resolved='0' AND t.resolved_group_pk IS NULL))
           AND (@s IS NULL OR t.patient_last LIKE @s OR t.patient_first LIKE @s
                OR t.order_number LIKE @s OR t.drug LIKE @s OR t.cardholder_id LIKE @s)
           AND (@paid IS NULL
                OR (@paid='unpaid'  AND ISNULL(p.paid,0)=0)
                OR (@paid='partial' AND ISNULL(p.paid,0)>0 AND ISNULL(p.paid,0)<ISNULL(t.amount,0))
                OR (@paid='paid'    AND ISNULL(t.amount,0)>0 AND ISNULL(p.paid,0)>=ISNULL(t.amount,0)))
           AND ${DAYS_CLAUSE('t.')}
         ORDER BY t.date_ordered_d DESC, t.source_id DESC`,
        { group: group || null, status: status || null,
          matched: (matched === '0' || matched === '1') ? parseInt(matched, 10) : null,
          resolved: (resolved === '0' || resolved === '1') ? resolved : null,
          paid: paid || null, s: search ? `%${search}%` : null, days: daysParam(days) })).recordset;
      return ok(r);
    }

    if (event.httpMethod === 'POST' && resource === 'payment') {
      const b = JSON.parse(event.body || '{}');
      const tid = parseInt(b.transaction_id, 10);
      const amt = parseFloat(b.amount);
      if (!tid) return badRequest('transaction_id required');
      if (!(amt > 0)) return badRequest('amount must be greater than 0');
      const who = user.email || user.name || user.username || 'user';
      const r = await mssql(
        `INSERT INTO dbo.tp_uf_transaction_payments
           (transaction_id, amount, paid_date, method, reference, note, created_by)
         VALUES (@tid,@amt,@date,@method,@reference,@note,@who);
         SELECT CAST(SCOPE_IDENTITY() AS INT) id;`,
        { tid, amt, date: b.paid_date || null, method: b.method || null,
          reference: b.reference || null, note: b.note || null, who });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'DELETE' && resource === 'payment') {
      const pid = parseInt(id, 10);
      if (!pid) return badRequest('id required');
      await mssql('DELETE FROM dbo.tp_uf_transaction_payments WHERE id=@pid', { pid });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
