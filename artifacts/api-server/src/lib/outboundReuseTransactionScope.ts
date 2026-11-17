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

export type LockedOutboundReuseScope = Readonly<{
  mutationId: number;
  invoiceId: number;
  disbursementId: number;
  sourceEntryId: number;
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
  const mutation = await tx.query<{ id: number; company_id: number; direction: string; status: string; journal_entry_id: number | null }>(
    `select id,company_id,direction,status,journal_entry_id
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
  const sourceItems = await tx.query<{ vendor_invoice_id: number | null }>(
    `select vendor_invoice_id from public.bank_disbursement_items
      where disbursement_id=$1 order by id for update`,
    [d.id],
  );
  if (sourceItems.rows.length !== 1
    || Number(sourceItems.rows[0].vendor_invoice_id) !== ids.invoiceId) {
    throw new Error("PR95_OUTBOUND_SOURCE_MULTI_INVOICE");
  }
  const entry = await tx.query<{ id: number }>(
    `select id from public.accounting_entries
      where id=$1 and company_id=$2 and source::text='manual_payment'
        and status::text='posted' and cancelled_at is null and voided_at is null
      for update`,
    [d.entry_id!, ids.companyId],
  );
  if (entry.rows.length !== 1) throw new Error("PR95_OUTBOUND_SOURCE_JOURNAL_INVALID");
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
    finality,
  };
}
