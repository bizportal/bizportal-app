/**
 * The existing bank reconciliation route stores vendor-invoice matches,
 * matching groups and payment allocations (NOT payment_request matches).
 * Read and lock precisely that existing canonical evidence. No writes.
 * Candidate handles one posted invoice per bank mutation only.
 */
import type { Client } from "pg";
export class NativeBankEvidenceError extends Error {
  constructor(readonly code: string) {super(code);}
}
function assertEvidence(condition: unknown, code: string): asserts condition {
  if(!condition)throw new NativeBankEvidenceError(code);
}
function amountCents(v: unknown):bigint|null{
 const raw=String(v);
 if(!/^(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(raw))return null;
 const [whole,minor=""]=raw.split(".");
 return BigInt(whole)*100n+BigInt((minor+"00").slice(0,2));
}
export async function verifyNativeVendorBankEvidence(
  client: Client, companyId: number, bankId: number, invoiceId: number,
  paymentRequestAmount: unknown,
): Promise<{groupId:number; allocationId:number}> {
  const bm=await client.query(`select linked_transaction_type,linked_transaction_id,
       company_id,amount::text as amount from public.bank_mutations
       where id=$1 for update`,[bankId]);
  assertEvidence(bm.rows.length===1&&bm.rows[0].company_id===companyId &&
    bm.rows[0].linked_transaction_type==="vendor_invoice_batch" &&
    bm.rows[0].linked_transaction_id===invoiceId,"NATIVE_VENDOR_BANK_LINK_INVALID");
  const match=await client.query(`select id,candidate_id::text as candidate_id from
    public.bank_reconciliation_matches
    where mutation_id=$1 and candidate_type='vendor_invoice'
      and candidate_source='public.vendor_invoices' and status in ('approved','posted')
    for update`,[bankId]);
  assertEvidence(match.rows.length===1 &&
    match.rows[0].candidate_id===String(invoiceId),"NATIVE_VENDOR_MATCH_INVALID");
  const allocated=await client.query(`select pa.id,pa.invoice_id,pa.company_id,
      pa.allocated_amount::text as amount,pa.group_id,
      pmg.company_id group_company,pmg.status group_status,
      pmg.remaining_amount::text as remainder,
      pmg.total_allocated::text as group_total
    from public.payment_allocations pa
    join public.payment_matching_groups pmg on pmg.id=pa.group_id
    where pa.mutation_id=$1 and pa.is_active=true
    for update of pa,pmg`,[bankId]);
  assertEvidence(allocated.rows.length===1,"MULTI_INVOICE_PAYMENT_BATCH_UNSUPPORTED");
  const row=allocated.rows[0];
  const expected=amountCents(paymentRequestAmount);
  assertEvidence(row.invoice_id===invoiceId && row.company_id===companyId &&
    row.group_company===companyId && row.group_status==="active" &&
    Number(row.id)>0 && Number(row.group_id)>0 &&
    expected!==null && expected>0n &&
    amountCents(row.amount)===expected &&
    amountCents(row.group_total)===expected &&
    amountCents(bm.rows[0].amount)===expected &&
    amountCents(row.remainder)===0n,"NATIVE_BANK_ALLOCATION_MISMATCH");
  // A matching group can also hold allocations for other mutations. This
  // candidate is intentionally single-invoice, so reject a shared group.
  const groupMembers=await client.query(`select id from public.payment_allocations
    where group_id=$1 and is_active=true for update`,[row.group_id]);
  assertEvidence(groupMembers.rows.length===1 &&
    groupMembers.rows[0].id===row.id,"SHARED_PAYMENT_GROUP_UNSUPPORTED");
  // Do not permit an allocation for the same invoice finalized elsewhere.
  const competitors=await client.query(`select pa.id from public.payment_allocations pa
    join public.bank_mutations bm on bm.id=pa.mutation_id
    where pa.company_id=$1 and pa.invoice_id=$2 and pa.mutation_id<>$3
      and pa.is_active=true and bm.status='posted'
    limit 1 for update of pa,bm`,[companyId,invoiceId,bankId]);
  assertEvidence(competitors.rows.length===0,"COMPETING_VENDOR_ALLOCATION");
  return {groupId:Number(row.group_id),allocationId:Number(row.id)};
}
