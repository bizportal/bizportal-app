/**
 * DEV-only admission for the existing vendor Invoice bank-allocation writer.
 * Never changes invoice status and never initiates a bank transaction.
 *
 * Legacy status=posted remains unchanged in bank-reconciliation.
 * Marketplace status=ready_for_ap may be used ONLY after this verifies the
 * exact locked AP/PaymentRequest/Handoff and the actual signed Super Admin.
 */
import type { VerifiedActor } from "./marketplacePaymentReleaseGate";
import { hasMarketplaceBankImportProvenance, type MarketplaceBankQueryClient } from "./marketplaceBankImportProvenance";

export class MarketplaceBankAllocationDenied extends Error {
  constructor(readonly code: string) { super(code); }
}
type QueryClient = MarketplaceBankQueryClient;
function deny(code:string):never {throw new MarketplaceBankAllocationDenied(code);}
function whole(v:unknown):v is number{return typeof v==="number"&&Number.isSafeInteger(v)&&v>0;}
function cents(v:unknown):bigint|null{
 const s=String(v);
 if(!/^(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(s))return null;
 const [w,d=""]=s.split(".");
 return BigInt(w)*100n+BigInt((d+"00").slice(0,2));
}
export async function authorizeMarketplaceReadyForApBankAllocation(
 client:QueryClient,
 actor:VerifiedActor|null,
 companyId:number,
 invoiceId:number,
 bankMutationId:number,
):Promise<{apId:number;requestId:number;handoffId:number}>{
 if(!whole(companyId)||!whole(invoiceId)||!whole(bankMutationId))deny("INVALID_IDS");
 if(!actor||actor.source!=="signed_server_session"||actor.role!=="super_admin")
   deny("SIGNED_SUPERADMIN_REQUIRED");
 if(actor.companyId!==companyId &&
    !(actor.companyId===null&&actor.approvedGlobalCompanyId===companyId))
   deny("COMPANY_SCOPE_FORBIDDEN");
 const result=await client.query(`
  select ap.id ap_id,pr.id request_id,h.id handoff_id,
    pr.approved_by,pr.approved_at,pr.mkt_approved_at,pr.mkt_treasury_ready_at,
    pr.status::text request_status,pr.total_amount::text request_amount,
    pr.paid_amount::text paid_amount,pr.journal_entry_id request_journal,
    pr.idempotency_key,pr.payload_fingerprint,h.payload_fingerprint handoff_fingerprint,
    h.status handoff_status,h.accounting_status,
    vi.status::text invoice_status,vi.three_way_match_status,
    bm.amount::text bank_amount,bm.direction,bm.status bank_status,
    bm.journal_entry_id bank_journal,to_jsonb(bm) bank_provenance
   from public.vendor_invoices vi
   join public.mkt_ap_preparations ap on ap.vendor_invoice_id=vi.id
      and ap.company_id=vi.company_id and ap.supplier_id=vi.supplier_id
   join public.mkt_accounting_handoffs h on h.ap_preparation_id=ap.id
      and h.vendor_invoice_id=vi.id and h.company_id=vi.company_id
   join public.payment_requests pr on pr.id=h.payment_request_id
      and pr.mkt_ap_preparation_id=ap.id and pr.company_id=vi.company_id
      and pr.supplier_id=vi.supplier_id and pr.source_type='marketplace_ap'
      and pr.source_id=ap.id
   join public.bank_mutations bm on bm.id=$3 and bm.company_id=vi.company_id
   where vi.id=$1 and vi.company_id=$2 and vi.status='ready_for_ap'
     and vi.three_way_match_status='passed' and ap.status='waiting_payment'
   for update of vi,ap,h,pr,bm
 `,[invoiceId,companyId,bankMutationId]);
 if(result.rows.length!==1)deny("AP_BANK_CHAIN_NOT_FOUND");
 const r=result.rows[0];
 if(!whole(r.ap_id)||!whole(r.request_id)||!whole(r.handoff_id))
   deny("BROKEN_ID_CHAIN");
 if(r.request_status!=="approved"||r.handoff_status!=="accepted"||
   r.accounting_status!=="draft_not_posted"||r.request_journal!==null||
   cents(r.paid_amount)!==0n)deny("REQUEST_ALREADY_USED_OR_NOT_APPROVED");
 if(r.approved_by!==actor.email || !r.approved_at ||
    !r.mkt_approved_at || !r.mkt_treasury_ready_at)
   deny("SIGNED_APPROVAL_OR_TREASURY_MISSING");
 if(r.idempotency_key!==`mkt-ap:${r.ap_id}` ||
   typeof r.payload_fingerprint!=="string" ||
   !/^[a-f0-9]{64}$/.test(r.payload_fingerprint) ||
   r.payload_fingerprint!==r.handoff_fingerprint)deny("HANDOFF_FINGERPRINT_INVALID");
 const amount=cents(r.request_amount), bank=cents(r.bank_amount);
 if(amount===null||amount<=0n||bank!==amount)deny("BANK_AMOUNT_MISMATCH");
 if(r.direction!=="OUT" || !["unmatched","matched","manual_review","duplicate_need_review"].includes(r.bank_status) ||
    r.bank_journal!==null || !await hasMarketplaceBankImportProvenance(client,r.bank_provenance,companyId))
   deny("BANK_MUTATION_NOT_ELIGIBLE");
 // The existing writer still performs its own bank-COA, PPh, duplicate
 // allocation, journal balance and COMMIT checks before approving the match.
 return {apId:r.ap_id,requestId:r.request_id,handoffId:r.handoff_id};
}
