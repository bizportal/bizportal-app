/**
 * PR95 transaction-scoped, read-only locking preflight for an authentic OUT
 * mutation / Vendor Invoice / existing posted Bank Disbursement source entry.
 * NOT a payment writer and NOT registered on a runtime route.
 *
 * Caller MUST authorize the company and BEGIN a real PostgreSQL transaction.
 * The same connection and lock order must be held until COMMIT/ROLLBACK.
 * Finality reads are necessary but not sufficient for release authorization.
 */
import {
  readOutboundReuseFinalityCounts,
  type OutboundReuseQueryClient,
} from "./outboundReuseFinalityReader";

/** Reject malformed fractional, rounded or unsafe money; store all comparisons in minor units. */
function minor(raw: unknown): number {
  const value = String(raw ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) throw new Error("PR95_OUTBOUND_AMOUNT_INVALID");
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("PR95_OUTBOUND_AMOUNT_INVALID");
  return result;
}

export type LockedOutboundReuseScope = Readonly<{
  mutationId: number;
  invoiceId: number;
  disbursementId: number;
  sourceEntryId: number;
  verifiedAmountMinor: number;
  finality: Awaited<ReturnType<typeof readOutboundReuseFinalityCounts>>;
}>;

export async function lockOutboundSourceJournalReuseScope(
  tx: OutboundReuseQueryClient,
  ids: { companyId: number; mutationId: number; invoiceId: number },
): Promise<LockedOutboundReuseScope> {
  if (![ids.companyId, ids.mutationId, ids.invoiceId]
    .every(v => Number.isSafeInteger(v) && v > 0)) {
    throw new Error("PR95_OUTBOUND_LOCK_SCOPE_INVALID");
  }
  // Company + mutation first; company + invoice second, consistent lock order.
  // Advisory locks serialize cooperating writers; they do NOT protect against
  // other code paths that ignore these locks. A genuine writer must have
  // unique DB constraints and recheck custody before any financial write.
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1::text,0))",
    [`pr95:bank-mutation:${ids.companyId}:${ids.mutationId}`]);
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1::text,0))",
    [`pr95:vendor-invoice:${ids.companyId}:${ids.invoiceId}`]);
  const mutation = await tx.query<{ id: number; company_id: number; direction: string; status: string; journal_entry_id: number | null; amount: string; bank_account_id: string | null }>(
    `select id,company_id,direction,status,journal_entry_id,amount::text as amount,bank_account_id
       from public.bank_mutations where id=$1 and company_id=$2 for update`,
    [ids.mutationId, ids.companyId],
  );
  const m = mutation.rows[0];
  if (!m || m.direction !== "OUT" || m.journal_entry_id !== null
    || !["unmatched","matched","pending","pending_review"].includes(String(m.status).toLowerCase())) {
    throw new Error("PR95_OUTBOUND_MUTATION_NOT_ELIGIBLE");
  }
  const invoice = await tx.query<{ id: number }>(
    `select id from public.vendor_invoices where id=$1 and company_id=$2
       and cancelled_at is null and status::text='posted' for update`,
    [ids.invoiceId, ids.companyId],
  );
  if (invoice.rows.length !== 1) throw new Error("PR95_OUTBOUND_INVOICE_NOT_POSTED");
  const disbursement = await tx.query<{ id: number; entry_id: number | null }>(
    `select bd.id,bd.entry_id
       from public.bank_disbursements bd
       join public.bank_disbursement_items bdi on bdi.disbursement_id=bd.id
      where bdi.vendor_invoice_id=$1 and bd.company_id=$2 and bd.status='posted'
        and bd.void_entry_id is null
      order by bd.id for update of bd,bdi`,
    [ids.invoiceId, ids.companyId],
  );
  if (disbursement.rows.length !== 1 || !Number.isSafeInteger(Number(disbursement.rows[0].entry_id))
    || Number(disbursement.rows[0].entry_id) <= 0) {
    throw new Error("PR95_OUTBOUND_SOURCE_AMBIGUOUS");
  }
  const d = disbursement.rows[0];
  // The matching item alone is insufficient: a posted disbursement can
  // contain OTHER invoice items. Lock and inspect ALL its items so a
  // multi-invoice bank credit is never reused as a single-invoice payment.
  const sourceItems = await tx.query<{ vendor_invoice_id: number | null; amount: string }>(
    `select vendor_invoice_id,amount::text as amount from public.bank_disbursement_items
      where disbursement_id=$1 order by id for update`,
    [d.id],
  );
  if (sourceItems.rows.length !== 1
    || Number(sourceItems.rows[0].vendor_invoice_id) !== ids.invoiceId) {
    throw new Error("PR95_OUTBOUND_SOURCE_MULTI_INVOICE");
  }
  const entry = await tx.query<{ id: number; total_debit: string; total_credit: string }>(
    `select id,total_debit::text as total_debit,total_credit::text as total_credit from public.accounting_entries
      where id=$1 and company_id=$2 and source::text='manual_payment'
        and status::text='posted' and cancelled_at is null and voided_at is null
      for update`,
    [d.entry_id!, ids.companyId],
  );
  if (entry.rows.length !== 1) throw new Error("PR95_OUTBOUND_SOURCE_JOURNAL_INVALID");
  // Exact persisted money evidence. Do not trust request-body amounts and do
  // not round numeric values to the nearest cent.
  const mutationMinor = minor(m.amount);
  const itemMinor = minor(sourceItems.rows[0].amount);
  const headerDebitMinor = minor(entry.rows[0].total_debit);
  const headerCreditMinor = minor(entry.rows[0].total_credit);
  const lineResult = await tx.query<{ debit: string; credit: string }>(
    `select debit::text as debit,credit::text as credit
       from public.accounting_entry_lines where entry_id=$1 order by id for update`,
    [entry.rows[0].id],
  );
  if (lineResult.rows.length < 2) throw new Error("PR95_OUTBOUND_LEDGER_MISMATCH");
  const cents = (raw: unknown): number => {
    const value = String(raw ?? "");
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
      throw new Error("PR95_OUTBOUND_AMOUNT_INVALID");
    }
    const [whole, fraction = ""] = value.split(".");
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(result) || result < 0) throw new Error("PR95_OUTBOUND_AMOUNT_INVALID");
    return result;
  };
  let debitMinor = 0;
  let creditMinor = 0;
  for (const line of lineResult.rows) {
    const debit = cents(line.debit);
    const credit = cents(line.credit);
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      throw new Error("PR95_OUTBOUND_LEDGER_MISMATCH");
    }
    debitMinor += debit;
    creditMinor += credit;
  }
  if (![debitMinor, creditMinor].every(Number.isSafeInteger)
    || mutationMinor !== itemMinor || mutationMinor !== headerDebitMinor
    || mutationMinor !== headerCreditMinor || mutationMinor !== debitMinor
    || mutationMinor !== creditMinor) {
    throw new Error("PR95_OUTBOUND_LEDGER_MISMATCH");
  }
  // Resolve the bank COA using the same canonical bank account owned by
  // this company. A correct amount alone cannot establish source provenance.
  const mappedBank = await tx.query<{ coa_id: number | null }>(
    `select cba.coa_id
       from public.company_bank_accounts cba
      where cba.id::text=$1 and cba.company_id=$2
        and cba.is_active=true and cba.coa_id is not null
      for update`,
    [m.bank_account_id ?? "",ids.companyId],
  );
  const bankCoaId = Number(mappedBank.rows[0]?.coa_id);
  if (mappedBank.rows.length !== 1 || !Number.isSafeInteger(bankCoaId)
    || bankCoaId <= 0) {
    throw new Error("PR95_OUTBOUND_BANK_COA_UNRESOLVED");
  }
  const bankCredit = await tx.query<{ n: string; credit: string; debit: string }>(
    `select count(*)::text as n,
            coalesce(sum(el.credit),0)::text as credit,
            coalesce(sum(el.debit),0)::text as debit
       from public.accounting_entry_lines el
       join public.chart_of_accounts coa on coa.id=el.account_id
      where el.entry_id=$1 and el.account_id=$2
        and (coa.company_id=$3 or coa.company_id is null)`,
    [entry.rows[0].id,bankCoaId,ids.companyId],
  );
  const bank = bankCredit.rows[0];
  if (!bank || Number(bank.n) !== 1
    || cents(bank.credit) !== mutationMinor
    || cents(bank.debit) !== 0) {
    throw new Error("PR95_OUTBOUND_BANK_COA_MISMATCH");
  }
  const finality = await readOutboundReuseFinalityCounts(tx, {
    companyId: ids.companyId, mutationId: ids.mutationId,
    invoiceId: ids.invoiceId, entryId: entry.rows[0].id,
  });
  if (finality.activeApprovedMutationLinkCount !== 0
    || finality.mutationFinalMatchCount !== 0
    || finality.sourceFinalAllocationCount !== 0) {
    throw new Error("PR95_OUTBOUND_FINALIZED_CUSTODY_EXISTS");
  }
  return {
    mutationId: ids.mutationId, invoiceId: ids.invoiceId,
    disbursementId: d.id, sourceEntryId: entry.rows[0].id,
    verifiedAmountMinor: mutationMinor,
    finality,
  };
}
