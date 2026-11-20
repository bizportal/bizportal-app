/**
 * DEV-only Marketplace AP Payment Request approval.
 * Reuses the existing company-scoped Drizzle transaction; never performs a
 * bank transfer or posts any GL. Caller must verify signed Super Admin.
 */
import { sql } from "drizzle-orm";
import type { VerifiedActor } from "./marketplacePaymentReleaseGate";

export class MarketplacePaymentApprovalDenied extends Error {
  constructor(readonly code: string) { super(code); }
}
function guard(ok: unknown, code: string): asserts ok {
  if (!ok) throw new MarketplacePaymentApprovalDenied(code);
}
const positive=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
const money=(v:unknown)=>{
  const x=String(v??"");
  return /^(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(x)
    ? BigInt(x.split(".")[0])*100n+BigInt((x.split(".")[1]??"").padEnd(2,"0")) : null;
};
export type ApprovalResult={
  requestId:number;companyId:number;status:"approved";replay:boolean;
  bankTransfer:false;glPosted:false;
};
type Transaction={execute:(query:ReturnType<typeof sql>)=>Promise<{rows:Record<string,any>[]}>};
export async function approveMarketplacePaymentRequest(
  db:Transaction,actor:VerifiedActor,requestId:number,
):Promise<ApprovalResult>{
  guard(positive(requestId),"INVALID_PAYMENT_REQUEST_ID");
  guard(actor?.source==="signed_server_session"&&actor.role==="super_admin"&&
    typeof actor.email==="string"&&actor.email.includes("@"),"SIGNED_SUPERADMIN_REQUIRED");
  const record=await db.execute(sql`
    select pr.id,pr.company_id,pr.supplier_id,pr.status::text status,
           pr.source_type,pr.source_id,pr.mkt_ap_preparation_id,
           pr.idempotency_key,pr.payload_fingerprint,pr.total_amount::text,
           pr.paid_amount::text,pr.journal_entry_id,
           pr.approved_by,pr.approved_at,pr.mkt_approved_by,pr.mkt_approved_at,
           pr.mkt_treasury_ready_by,pr.mkt_treasury_ready_at,
           ap.status::text ap_status,ap.vendor_invoice_id,
           ap.grand_total_snapshot::text ap_total,
           h.id handoff_id,h.status handoff_status,h.accounting_status,
           h.payload_fingerprint handoff_fingerprint,h.handoff_key,
           h.amount::text handoff_total,
           vi.status::text invoice_status,vi.three_way_match_status,
           vi.grand_total::text invoice_total
    from public.payment_requests pr
    join public.mkt_ap_preparations ap on ap.id=pr.mkt_ap_preparation_id
      and ap.company_id=pr.company_id and ap.supplier_id=pr.supplier_id
    join public.mkt_accounting_handoffs h on h.payment_request_id=pr.id
      and h.ap_preparation_id=ap.id and h.company_id=pr.company_id
      and h.vendor_invoice_id=ap.vendor_invoice_id
    join public.vendor_invoices vi on vi.id=ap.vendor_invoice_id
      and vi.company_id=pr.company_id and vi.supplier_id=pr.supplier_id
    where pr.id=${requestId} and pr.source_type='marketplace_ap'
    for update of pr
  `);
  guard(record.rows.length===1,"PAYMENT_CHAIN_NOT_FOUND");
  const r=record.rows[0]!;
  const company=Number(r.company_id);
  guard(positive(company)&&
    (actor.companyId===company ||
      (actor.companyId===null&&actor.approvedGlobalCompanyId===company)),
    "COMPANY_SCOPE_FORBIDDEN");
  guard(r.source_id===r.mkt_ap_preparation_id&&
    r.idempotency_key===`mkt-ap:${r.mkt_ap_preparation_id}`&&
    typeof r.payload_fingerprint==="string"&&
    /^[a-f0-9]{64}$/.test(r.payload_fingerprint)&&
    r.payload_fingerprint===r.handoff_fingerprint&&
    r.handoff_key===r.idempotency_key,"PAYMENT_FINGERPRINT_INVALID");
  guard(r.ap_status==="waiting_payment"&&r.handoff_status==="accepted"&&
    r.accounting_status==="draft_not_posted"&&r.invoice_status==="ready_for_ap"&&
    r.three_way_match_status==="passed","AP_NOT_READY");
  const total=money(r.total_amount);
  guard(total!==null&&total>0n&&money(r.paid_amount)===0n&&
    r.journal_entry_id===null,"REQUEST_ALREADY_PAID_OR_INVALID");
  guard(total===money(r.ap_total)&&total===money(r.handoff_total)&&
    total===money(r.invoice_total),"AMOUNT_SNAPSHOT_MISMATCH");
  if(r.status==="approved"){
    guard(r.approved_by===actor.email&&r.mkt_approved_by===actor.email&&
      r.mkt_treasury_ready_by===actor.email&&r.approved_at&&
      r.mkt_approved_at&&r.mkt_treasury_ready_at,"APPROVAL_REPLAY_CONFLICT");
    return {requestId,companyId:company,status:"approved",replay:true,
      bankTransfer:false,glPosted:false};
  }
  guard(r.status==="draft"&&!r.approved_by&&!r.approved_at&&
    !r.mkt_approved_at&&!r.mkt_treasury_ready_at,"REQUEST_NOT_DRAFT");
  const approved=await db.execute(sql`
    update public.payment_requests
       set status='approved',approved_by=${actor.email},approved_at=now(),
           mkt_approved_by=${actor.email},mkt_approved_at=now(),
           mkt_treasury_ready_by=${actor.email},mkt_treasury_ready_at=now(),
           mkt_lifecycle_status='treasury_ready'
     where id=${requestId} and company_id=${company} and status='draft'
       and source_type='marketplace_ap' and paid_amount=0
       and journal_entry_id is null
     returning id
  `);
  guard(approved.rows.length===1,"PAYMENT_APPROVAL_CONFLICT");
  // This audit is in the SAME company-scoped transaction as the update.
  // A denied audit INSERT must roll back the entire approval.
  await db.execute(sql`
    insert into public.mkt_payment_approval_audit_dev
      (company_id,payment_request_id,actor_email,decision,created_at)
    values (${company},${requestId},${actor.email},'approved',now())
  `);
  return {requestId,companyId:company,status:"approved",replay:false,
    bankTransfer:false,glPosted:false};
}
