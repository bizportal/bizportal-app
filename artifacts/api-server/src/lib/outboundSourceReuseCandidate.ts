/**
 * PR95 candidate only. NOT imported by production routes; NOT a cutover gate.
 * Caller must verify an authenticated finance principal and supply the SAME
 * transaction-scoped pg client from BEGIN through COMMIT/ROLLBACK.
 *
 * Source Bank Disbursement already posted the AP->Bank journal. Reuse the
 * immutable existing entry; NEVER insert or post another accounting entry.
 * Scope: exactly one posted Vendor Invoice, exact full cash settlement,
 * no WHT, no partial/multi-invoice allocations, authentic OUT mutation.
 */
import { lockOutboundSourceJournalReuseScope } from "./outboundReuseTransactionScope";
import type { OutboundReuseQueryClient } from "./outboundReuseFinalityReader";

type CandidateReceipt = Readonly<{
  mutationId: number;
  invoiceId: number;
  sourceEntryId: number;
  paymentMatchingGroupId: number;
}>;

export async function finalizeOutboundSourceReuseCandidate(
  tx: OutboundReuseQueryClient,
  input: { companyId: number; mutationId: number; invoiceId: number; verifiedActorEmail: string },
): Promise<CandidateReceipt> {
  if (![input.companyId,input.mutationId,input.invoiceId]
      .every(v=>Number.isSafeInteger(v)&&v>0)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.verifiedActorEmail)) {
    throw Error("PR95_SOURCE_REUSE_INVALID_ACTOR_SCOPE");
  }
  const locked=await lockOutboundSourceJournalReuseScope(tx,input);
  // No pending tax/withholding, discount, or partial bank settlement: the
  // source bank credit and invoice gross must be identical.
  const inv=await tx.query<{grand_total:string;status:string}>(
    `select grand_total::text as grand_total,status::text as status
       from public.vendor_invoices
      where id=$1 and company_id=$2 and cancelled_at is null for update`,
    [input.invoiceId,input.companyId],
  );
  const original=inv.rows[0];
  // PostgreSQL NUMERIC is a decimal string. Compare exact minor units
  // without binary-float multiplication or rounding a partial cent.
  const rawGross=String(original?.grand_total??"");
  const validGross=/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(rawGross);
  const [whole="",fraction=""] = rawGross.split(".");
  const grossMinor=validGross
    ? Number(whole)*100+Number(fraction.padEnd(2,"0"))
    : NaN;
  if(!original || original.status!=="posted" || !Number.isSafeInteger(grossMinor)
    || grossMinor!==locked.verifiedAmountMinor) {
    throw Error("PR95_SOURCE_REUSE_PARTIAL_OR_TAX_UNSUPPORTED");
  }

  const ap=await tx.query<{n:string;debit:string;credit:string}>(
    `select count(*)::text as n,
            coalesce(sum(el.debit),0)::text as debit,
            coalesce(sum(el.credit),0)::text as credit
       from public.accounting_entry_lines el
       join public.chart_of_accounts coa on coa.id=el.account_id
      where el.entry_id=$1 and coa.company_id=$2
        and coa.code='2-1010-CST' and coa.is_active=true`,
    [locked.sourceEntryId,input.companyId],
  );
  const apRow=ap.rows[0];
  if(!apRow || Number(apRow.n)!==1
    || Math.round(Number(apRow.debit)*100)!==locked.verifiedAmountMinor
    || Number(apRow.credit)!==0) {
    throw Error("PR95_SOURCE_REUSE_AP_CUSTODY_INVALID");
  }
  // Lock all existing matches for this mutation before writing; an earlier
  // approved or posted match must not be superseded and acknowledged.
  const existing=await tx.query<{id:number;status:string}>(
    `select id,status from public.bank_reconciliation_matches
      where mutation_id=$1 order by id for update`,
    [input.mutationId],
  );
  if(existing.rows.some(m=>["approved","posted"].includes(m.status.toLowerCase())))
    throw Error("PR95_SOURCE_REUSE_EXISTING_FINAL_MATCH");

  // Retire only unfinished match candidates; all insert/update statements
  // execute inside the caller's transaction and must be rolled back together.
  await tx.query(
    `update public.bank_reconciliation_matches set status='superseded'
       where mutation_id=$1 and status not in ('approved','posted')`,
    [input.mutationId],
  );
  const group=await tx.query<{id:number}>(
    `insert into public.payment_matching_groups
        (company_id,group_type,matching_type,total_mutation_amount,
         total_invoice_amount,total_allocated,remaining_amount,
         confidence,algorithm_used,status,created_by)
       values($1,'MULTI_INVOICE','MULTI_INVOICE',$2,$2,$2,0,100,
              'bank_source_journal_reuse_verified','final',$3)
       returning id`,
    [input.companyId,locked.verifiedAmountMinor/100,input.verifiedActorEmail],
  );
  const groupId=Number(group.rows[0]?.id);
  if(!Number.isSafeInteger(groupId)||groupId<=0)throw Error("PR95_SOURCE_REUSE_GROUP_FAILURE");
  await tx.query(
    `insert into public.payment_allocations
        (group_id,company_id,invoice_id,mutation_id,allocated_amount,
         remaining_amount,allocation_sequence,strategy,is_active)
       values($1,$2,$3,$4,$5,0,1,'MANUAL',true)`,
    [groupId,input.companyId,input.invoiceId,input.mutationId,locked.verifiedAmountMinor/100],
  );
  await tx.query(
    `insert into public.bank_reconciliation_matches
       (mutation_id,candidate_type,candidate_id,match_score,match_reason,
        amount_match,date_match,name_match,order_id_match,proof_match,
        status,candidate_source,is_manual)
       values($1,'vendor_invoice',$2,100,'verified source Bank Disbursement journal',
              true,false,true,false,false,'approved','public.vendor_invoices',true)`,
    [input.mutationId,String(input.invoiceId)],
  );
  const updated=await tx.query<{id:number}>(
    `update public.bank_mutations
        set status='posted',reconciliation_status='reconciled',
            accounting_posted=true,journal_entry_id=$2,
            approved_at=coalesce(approved_at,now()),approved_by=$3,
            posted_at=coalesce(posted_at,now()),
            linked_transaction_type='vendor_invoice_batch',
            linked_transaction_id=$4,review_code='SOURCE_JOURNAL_REUSED',
            updated_at=now()
      where id=$1 and company_id=$5 and journal_entry_id is null
        and status in ('unmatched','matched','pending','pending_review')
      returning id`,
    [input.mutationId,locked.sourceEntryId,input.verifiedActorEmail,input.invoiceId,input.companyId],
  );
  if(updated.rows.length!==1)throw Error("PR95_SOURCE_REUSE_MUTATION_CHANGED");
  await tx.query(
    `insert into public.bank_reconciliation_audit(mutation_id,action,actor,meta)
       values($1,'CANONICAL_POSTED',$2,$3::jsonb)`,
    [input.mutationId,input.verifiedActorEmail,JSON.stringify({
      reason:"Verified existing posted source journal reuse (no new journal)",
      journal_entry_id:locked.sourceEntryId,
      disbursement_id:locked.disbursementId,
      invoice_id:input.invoiceId,
      matching_group_id:groupId,
      contract:"pr95-unregistered-outbound-source-reuse-candidate",
    })],
  );
  return {mutationId:input.mutationId,invoiceId:input.invoiceId,
    sourceEntryId:locked.sourceEntryId,paymentMatchingGroupId:groupId};
}
