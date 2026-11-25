/**
 * CST-DEV candidate: reconcile an ALREADY posted outgoing bank mutation
 * back to an approved Marketplace AP Payment Request in ONE SQL transaction.
 * NEVER initiates a bank transfer or posts a GL entry.
 * UNMOUNTED; an authenticated controller must derive actor from server session,
 * never from a caller-controlled email/company header.
 */
import type { Client } from "pg";
import type { VerifiedActor } from "./marketplacePaymentReleaseGate";
import { verifyNativeVendorBankEvidence } from "./nativeVendorBankEvidence";
import { hasMarketplaceBankImportProvenance } from "./marketplaceBankImportProvenance";

export type FinalizeResult = {status:"CONFIRMED"|"REPLAY";paymentRequestId:number;bankMutationId:number;journalEntryId:number};
export class PaymentFinalizationDenied extends Error {
  constructor(readonly code:string){super(code);}
}
function requireState(ok:unknown,code:string):asserts ok {if(!ok)throw new PaymentFinalizationDenied(code);}
const exactMoney=(v:unknown):bigint|null=>{
  if(typeof v!=="string"||!/^(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(v))return null;
  const [i,f=""]=v.split(".");
  return BigInt(i)*100n+BigInt((f+"00").slice(0,2));
};
type SqlRow = Record<string,unknown>;
type Db={query:(sql:string,params?:unknown[])=>Promise<{rows:SqlRow[]}>};
const asId=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0?v:null;
function requireCompany(actor:VerifiedActor,company:number){
  requireState(actor?.source==="signed_server_session" && actor.role==="super_admin","SIGNED_SUPERADMIN_REQUIRED");
  requireState(actor.companyId===company || (actor.companyId===null && actor.approvedGlobalCompanyId===company),"COMPANY_SCOPE_FORBIDDEN");
}
const one=async(db:Db,query:string,params:unknown[],code:string)=>{
 const result=await db.query(query,params);
 requireState(result.rows.length===1,code);
 return result.rows[0]!;
};
/** Dedicated pg Client or PoolClient. BEGIN/COMMIT belong only here. */
export async function finalizePostedMarketplacePayment(
  client:Client,actor:VerifiedActor,requestId:number,bankId:number,
):Promise<FinalizeResult>{
  requireState(asId(requestId)&&asId(bankId),"INVALID_IDS");
  await client.query("BEGIN");
  try{
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SET LOCAL statement_timeout='12s'");
    // Fixed lock order, including replay; no caller-provided company authority.
    const p=await one(client,`select * from public.payment_requests where id=$1 for update`,[requestId],"REQUEST_NOT_FOUND");
    const company=asId(p.company_id);requireState(company,"INVALID_COMPANY");
    requireCompany(actor,company);
    requireState(p.source_type==="marketplace_ap" && asId(p.mkt_ap_preparation_id)===asId(p.source_id),"NOT_MARKETPLACE_AP");
    requireState(p.idempotency_key===`mkt-ap:${p.mkt_ap_preparation_id}`,"REQUEST_KEY_MISMATCH");
    requireState(typeof p.approved_by==="string" && p.approved_by.toLowerCase()===actor.email.toLowerCase()
      && p.approved_at && p.mkt_approved_at && p.mkt_treasury_ready_at,"SIGNED_APPROVAL_MISSING");
    const handoff=await one(client,`select * from public.mkt_accounting_handoffs
       where payment_request_id=$1 and company_id=$2 for update`,[requestId,company],"HANDOFF_MISSING");
    const ap=await one(client,`select * from public.mkt_ap_preparations where id=$1 and company_id=$2 for update`,
      [p.mkt_ap_preparation_id,company],"AP_MISSING");
    const vi=await one(client,`select * from public.vendor_invoices where id=$1 and company_id=$2 for update`,
      [handoff.vendor_invoice_id,company],"INVOICE_MISSING");
    requireState(ap.status==="waiting_payment" && ap.vendor_invoice_id===vi.id &&
      handoff.ap_preparation_id===ap.id && handoff.vendor_invoice_id===vi.id &&
      ap.supplier_id===p.supplier_id && vi.supplier_id===p.supplier_id,"AP_REFERENCE_MISMATCH");
    // Marketplace AP retains ready_for_ap. The separately opt-in bank adapter
    // must have verified signed approval and this exact canonical AP chain.
    // Finalization requires a later posted bank mutation and native allocation.
    requireState(vi.status==="ready_for_ap" && vi.three_way_match_status==="passed","AP_INVOICE_NOT_READY");
    requireState(handoff.payload_fingerprint===p.payload_fingerprint &&
      /^[a-f0-9]{64}$/.test(String(handoff.payload_fingerprint)) &&
      handoff.handoff_key===p.idempotency_key,"HANDOFF_FINGERPRINT_INVALID");

    // Bank evidence MUST be imported from a bank statement AND explicitly
    // bound by canonical reconciler to THIS exact Payment Request.
    const bank=await one(client,`select * from public.bank_mutations where id=$1 and company_id=$2 for update`,
      [bankId,company],"BANK_MUTATION_NOT_FOUND");
    requireState(bank.direction==="OUT" && bank.status==="posted" && bank.accounting_posted===true &&
      bank.reconciliation_status==="reconciled" && bank.journal_entry_id!==null &&
      await hasMarketplaceBankImportProvenance(client,bank,company),"BANK_NOT_POSTED_FROM_IMPORT");
    // Verify the existing canonical Vendor Invoice allocation chain (one
    // invoice only). A Payment Request link is derived from locked AP/Handoff;
    // do not trust a caller-supplied bank source tag.
    const nativeProof=await verifyNativeVendorBankEvidence(
      client,company,bankId,Number(vi.id),p.total_amount);
    requireState(nativeProof.groupId>0 && nativeProof.allocationId>0,"BANK_NATIVE_PROOF_MISSING");
    const amount=exactMoney(String(p.total_amount));
    requireState(amount!==null && amount>0n && amount===exactMoney(String(bank.amount)) &&
      amount===exactMoney(String(handoff.amount)),"AMOUNT_MISMATCH");
    const journal=await one(client,`select * from public.accounting_entries
       where id=$1 and company_id=$2 and source='bank_reconciliation' and source_id=$3
       and status='posted' for update`,
      [bank.journal_entry_id,company,bankId],"CANONICAL_POSTED_JOURNAL_REQUIRED");
    const journalId=asId(journal.id);
    requireState(journalId,"INVALID_JOURNAL_ID");
    // The canonical line schema does not carry company_id. Its company is
    // established by the locked journal header and its actual posting COA.
    const lines=await client.query(`select line.debit::text,line.credit::text,line.account_id,
       coa.company_id account_company_id,
       (select count(*)::int from public.accounting_entry_lines all_lines
        where all_lines.entry_id=$1) journal_line_count,
       to_jsonb(line)->>'company_id' legacy_line_company_id
       from public.accounting_entry_lines line
       join public.chart_of_accounts coa on coa.id=line.account_id
       where line.entry_id=$1 for update of line,coa`,[journal.id]);
    requireState(lines.rows.length>=2 && lines.rows.length===lines.rows[0]?.journal_line_count && lines.rows.every(r=>
      r.account_company_id===company &&
      (r.legacy_line_company_id==null || Number(r.legacy_line_company_id)===company)),"JOURNAL_COMPANY_MISMATCH");
    let debit=0n,credit=0n;
    for(const line of lines.rows){
      const a=exactMoney(line.debit),b=exactMoney(line.credit);
      requireState(a!==null&&b!==null&&asId(line.account_id),"JOURNAL_LINE_INVALID");
      debit+=a;credit+=b;
    }
    requireState(debit>0n&&debit===credit &&
      debit===exactMoney(String(journal.total_debit)) &&
      credit===exactMoney(String(journal.total_credit)),"UNBALANCED_JOURNAL");
    requireState(bank.bank_account_id && bank.approved_at,"BANK_ACCOUNT_OR_APPROVAL_MISSING");
    // Resolve the bank account and posting COA from server-owned company master.
    // Never trust an account id or COA suggested by the client.
    const mapped=await one(client,`select coa.id as coa_id from public.company_bank_accounts ba
      join public.chart_of_accounts coa on coa.id=ba.coa_id and coa.company_id=ba.company_id
      where ba.company_id=$1 and (ba.id::text=$2 or ba.account_number=$2)
        and ba.is_active=true and coa.is_active=true and coa.is_postable=true
      for update of ba,coa`,[company,bank.bank_account_id],"ACTIVE_COMPANY_BANK_COA_REQUIRED");
    requireState(lines.rows.some(line=>line.account_id===mapped.coa_id &&
      (exactMoney(line.credit)??0n)>0n),"BANK_COA_CREDIT_MISSING");

    if(p.status==="paid"){
      requireState(p.journal_entry_id===journal.id &&
        exactMoney(String(p.paid_amount))===amount &&
        handoff.accounting_status==="posted" &&
        handoff.accounting_reference===`BANK-MUTATION-${bankId}` &&
        p.mkt_completed_at,"PAID_REPLAY_CONFLICT");
      await client.query("COMMIT");
      return {status:"REPLAY",paymentRequestId:requestId,bankMutationId:bankId,journalEntryId:journalId};
    }
    requireState(p.status==="approved" && exactMoney(String(p.paid_amount))===0n &&
      p.journal_entry_id===null && handoff.status==="accepted" &&
      handoff.accounting_status==="draft_not_posted","REQUEST_NOT_READY");
    const write=await client.query(`update public.payment_requests set status='paid',paid_amount=total_amount,
       journal_entry_id=$2,mkt_completed_at=now(),updated_at=now()
       where id=$1 and company_id=$3 and status='approved' and paid_amount=0
         and journal_entry_id is null returning id`,[requestId,journal.id,company]);
    requireState(write.rows.length===1,"REQUEST_RACE_CONFLICT");
    const handoffWrite=await client.query(`update public.mkt_accounting_handoffs
       set accounting_status='posted',accounting_reference=$2,updated_at=now()
       where id=$1 and company_id=$3 and accounting_status='draft_not_posted'
       returning id`,[handoff.id,`BANK-MUTATION-${bankId}`,company]);
    requireState(handoffWrite.rows.length===1,"HANDOFF_RACE_CONFLICT");
    await client.query(`insert into public.audit_logs
      (user_email,action,entity_type,entity_id,company_id,module,after_data)
      values($1,'marketplace_ap_bank_finalized','payment_request',$2,$3,
      'marketplace_finance',$4::jsonb)`,
      [actor.email,String(requestId),String(company),
       JSON.stringify({bankMutationId:bankId,journalEntryId:journal.id,handoffId:handoff.id,
         source:"signed_superadmin_canonical_bank"})]);
    await client.query("COMMIT");
    return {status:"CONFIRMED",paymentRequestId:requestId,bankMutationId:bankId,journalEntryId:journalId};
  }catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  }
}
