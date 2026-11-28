/**
 * Transaction-scoped preflight for the ORIGINAL Bank Disbursement writer.
 *
 * This is a candidate library, NOT mounted to a live payment endpoint.
 * Call it with the SAME PostgreSQL client *inside* the write transaction,
 * before creating GL entries or bank-disbursement rows. The row lock is
 * effective only when that transaction remains open through COMMIT.
 * No writes, secrets, or runtime payment activation in this module.
 */
import type { Client } from "pg";

export class VendorDisbursementRepeatError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VendorDisbursementRepeatError";
  }
}

function parseCents(input: unknown): bigint {
  const raw = String(input);
  if (!/^(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(raw)) {
    throw new VendorDisbursementRepeatError("INVALID_PAYMENT_AMOUNT");
  }
  const [whole, decimals = ""] = raw.split(".");
  return BigInt(whole) * 100n + BigInt((decimals + "00").slice(0, 2));
}

type InvoiceLockRow = {
  id: number;
  grand_total: string;
  amount_paid: string | null;
  status: string;
};
type PostedRow = { posted_amount: string; active_disbursements: string };
type FinalizedRow = { final_amount: string };

export type VendorDisbursementPreflight = {
  invoiceId: number;
  companyId: number;
  remainingCents: bigint;
  pendingPostedDisbursementCents: bigint;
};

/**
 * Fail closed for any existing unvoided POSTED supplier disbursement that has
 * not been finally reconciled. This deliberately blocks follow-up partial
 * payments until there is canonical bank evidence; it cannot infer whether
 * invoice.amount_paid and final allocations represent different payments.
 *
 * The writer MUST use transaction BEGIN, invoke this guard with that client,
 * perform all journal+disbursement writes with the SAME client, then COMMIT.
 */
export async function assertVendorDisbursementMayPost(
  client: Pick<Client, "query">,
  companyId: number,
  invoiceId: number,
  paymentAmount: unknown,
): Promise<VendorDisbursementPreflight> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 ||
      !Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
    throw new VendorDisbursementRepeatError("INVALID_VENDOR_INVOICE_SCOPE");
  }
  const requested = parseCents(paymentAmount);
  if (requested <= 0n) throw new VendorDisbursementRepeatError("INVALID_PAYMENT_AMOUNT");

  // Must be called inside the writer's transaction; serializes other
  // integrations using the same invoice FOR UPDATE gate.
  const invoice = await client.query<InvoiceLockRow>(
    `select id, grand_total::text as grand_total,
            amount_paid::text as amount_paid, status::text as status
       from public.vendor_invoices
      where id=$1 and company_id=$2 and cancelled_at is null
      for update`,
    [invoiceId, companyId],
  );
  const locked = invoice.rows[0];
  if (!locked || locked.status !== "posted") {
    throw new VendorDisbursementRepeatError("VENDOR_INVOICE_NOT_POSTED");
  }

  const posted = await client.query<PostedRow>(
    `select coalesce(sum(bdi.amount),0)::text as posted_amount,
            count(distinct bd.id)::text as active_disbursements
       from public.bank_disbursement_items bdi
       join public.bank_disbursements bd on bd.id=bdi.disbursement_id
      where bdi.vendor_invoice_id=$1 and bd.company_id=$2
        and bdi.transaction_type='supplier_payment'
        and bd.status='posted' and bd.void_entry_id is null`,
    [invoiceId, companyId],
  );
  const postedCents = parseCents(posted.rows[0]?.posted_amount ?? "0");
  const postedCount = BigInt(posted.rows[0]?.active_disbursements ?? "0");
  // A posted disbursement can be linked to a final bank allocation later,
  // but never allow another supplier payment until that proof is resolved.
  if (postedCount > 0n || postedCents > 0n) {
    throw new VendorDisbursementRepeatError("VENDOR_DISBURSEMENT_PENDING_RECONCILIATION");
  }

  const allocations = await client.query<FinalizedRow>(
    `select coalesce(sum(pa.allocated_amount),0)::text as final_amount
       from public.payment_allocations pa
       left join public.payment_matching_groups pmg on pmg.id=pa.group_id
      where pa.company_id=$1 and pa.invoice_id=$2 and pa.is_active=true
        and lower(coalesce(pmg.status,'')) in ('final','posted','reconciled')`,
    [companyId, invoiceId],
  );
  const finalized = parseCents(allocations.rows[0]?.final_amount ?? "0");
  const legacyPaid = parseCents(locked.amount_paid ?? "0");
  const gross = parseCents(locked.grand_total);
  // Fail closed on overlapping legacy and final figures rather than treating
  // them as independent payments and accidentally double counting.
  const recognized = finalized > legacyPaid ? finalized : legacyPaid;
  const remaining = gross > recognized ? gross - recognized : 0n;
  if (requested > remaining) {
    throw new VendorDisbursementRepeatError("VENDOR_INVOICE_OVERPAYMENT");
  }
  return { invoiceId, companyId, remainingCents: remaining,
    pendingPostedDisbursementCents: postedCents };
}
