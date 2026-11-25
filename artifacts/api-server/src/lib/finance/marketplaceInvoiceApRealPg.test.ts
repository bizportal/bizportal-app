import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import pg from "pg";
import {drizzle} from "drizzle-orm/node-postgres";
import {PgDialect} from "drizzle-orm/pg-core";
import {readFileSync} from "node:fs";
import path from "node:path";
import {approveMarketplacePaymentRequest} from "./marketplacePaymentApproval";
import {finalizePostedMarketplacePayment} from "./marketplacePaymentFinalization";
import {postBankMutationCanonical} from "../../routes/bank-reconciliation";
import {authorizeMarketplaceReadyForApBankAllocation} from "./marketplaceInvoiceBankStatusAdapter";
import type {VerifiedActor} from "./marketplacePaymentReleaseGate";
import * as schema from "@workspace/db/schema";
vi.mock("@workspace/db",async()=>{
 const tables=await import("@workspace/db/schema");
 return {...tables,db:{},onMarketplaceFinanceCommit:vi.fn()};
});
vi.mock("../activityLog.js",()=>({logActivity:vi.fn()}));
vi.mock("../services/marketplaceNotificationQueueService.js",()=>({enqueueNotification:vi.fn(async()=>undefined)}));
import {createMarketplaceVendorInvoice,submitMarketplaceVendorInvoice} from "../services/mktVendorInvoiceService.js";
import {createApPreparation,reviewApPreparation,markApPreparationWaitingPayment,createMarketplaceAccountingHandoff} from "../services/mktApPreparationService.js";
const url="postgres://postgres@127.0.0.1:55497/postgres";
let admin:pg.Client;
const vendor={actorType:"vendor" as const,actorId:"QA-PO14"};
const actor={actorId:"qa-owner@invalid.example",actorName:"CST QA Owner"};
const invoiceInput={
 poId:14,grId:6,vendorInvoiceRef:"QA-PO14-INTERNAL-TEST-ONLY",
 invoiceDate:new Date("2026-11-25T00:00:00Z"),currency:"IDR",
 totalAmount:100000,taxAmount:0,grandTotal:100000,
 supplierId:24,supplierName:"PT Cahaya Sejati Teknologi",companyId:1,
 lines:[{poLineId:14,quantity:1,unitPrice:100000,subtotal:100000,name:"Frozen Tuna Saku",unit:"pcs"}],
 attachment:{objectPath:"isolated/qa-po14/not-a-real-invoice.pdf",fileName:"TEST-ONLY.pdf",contentType:"application/pdf",size:27},
};
beforeAll(async()=>{
 admin=new pg.Client({connectionString:url});await admin.connect();
 await admin.query(readFileSync(path.resolve(import.meta.dirname,
  "../../../../../scripts/sql/20261125_po14_isolated_finance_bank_fixtures_ONLY.sql"),"utf8"));
},30000);
afterAll(async()=>{await admin?.end();});
beforeEach(async()=>{
 process.env.APP_ENV="development";
 process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV="false";
 process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV="false";
 await admin.query(`truncate public.mkt_payment_approval_audit_dev,
 public.bank_reconciliation_audit,public.audit_logs,
 public.accounting_entry_lines,public.accounting_entries,
 public.bank_reconciliation_matches,public.payment_allocations,
 public.payment_matching_groups,public.bank_mutations,
 public.chart_of_accounts,public.company_bank_accounts,
 public.mkt_accounting_handoffs,public.payment_requests,
 public.mkt_ap_preparations,public.vendor_invoice_lines,public.vendor_invoices,
 public.mkt_po_goods_receipt_items,public.mkt_po_goods_receipts,
 public.mkt_po_shipment_items,public.mkt_po_shipments,
 public.mkt_purchase_order_lines,public.mkt_purchase_orders,public.suppliers
 restart identity cascade`);
 await admin.query(`
 insert into public.suppliers(id,company_id,name,is_active) values(24,1,'PT Cahaya Sejati Teknologi',true);
 insert into public.mkt_purchase_orders
 (id,po_number,rfq_id,quote_id,company_id,vendor_id,status,total_amount,tax_amount,grand_total,currency_snapshot)
 values(14,'PO-20261117-00014',1,1,1,24,'completed',100000,0,100000,'IDR');
 insert into public.mkt_purchase_order_lines(id,po_id,item_name,qty,unit,unit_price,subtotal)
 values(14,14,'Frozen Tuna Saku',1,'pcs',100000,100000);
 insert into public.mkt_po_shipments(id,po_id,shipment_number,shipment_status)
 values(8,14,'QA-SHIP-8','delivered');
 insert into public.mkt_po_shipment_items(id,shipment_id,po_line_id,line_number,qty)
 values(8,8,14,1,1);
 insert into public.mkt_po_goods_receipts(id,shipment_id,receipt_number,receipt_type,inspection_status)
 values(6,8,'QA-GR-6','full','passed');
 insert into public.mkt_po_goods_receipt_items
 (id,goods_receipt_id,shipment_item_id,received_qty,accepted_qty,rejected_qty)
 values(6,6,8,1,1,0);
 `);
});
async function runInvoiceAp(){
 const c=new pg.Client({connectionString:url});await c.connect();
 const scoped=drizzle(c,{schema});
 try{
  const created=await createMarketplaceVendorInvoice(invoiceInput,vendor,scoped as never);
  expect(created.ok).toBe(true);if(!created.ok)throw Error(created.code);
  const id=created.invoice.id;
  const matched=await submitMarketplaceVendorInvoice(id,vendor,scoped as never);
  expect(matched).toMatchObject({ok:true,invoice:{status:"ready_for_ap",threeWayMatchStatus:"passed"}});
  const prep=await createApPreparation(id,actor,scoped as never);
  expect(prep.ok).toBe(true);if(!prep.ok)throw Error(prep.code);
  const reviewed=await reviewApPreparation(prep.preparation.id,actor,scoped as never);
  expect(reviewed).toMatchObject({ok:true,preparation:{status:"finance_review"}});
  const waiting=await markApPreparationWaitingPayment(prep.preparation.id,actor,scoped as never);
  expect(waiting).toMatchObject({ok:true,preparation:{status:"waiting_payment"}});
  const handoff=await createMarketplaceAccountingHandoff(prep.preparation.id,actor,scoped as never);
  expect(handoff).toMatchObject({ok:true,alreadyExists:false});
  if(!handoff.ok)throw Error(handoff.code);
  return {id,apId:prep.preparation.id,requestId:handoff.paymentRequestId,handoffId:handoff.handoffId};
 }finally{await c.end();}
}
describe("canonical Invoice / AP / Payment Request SQL against isolated PG",()=>{
 it("creates matched Invoice and AP plus exactly one draft Payment Request",async()=>{
  const refs=await runInvoiceAp();
  const r=await admin.query(`select vi.status::text invoice_status,vi.three_way_match_status,
   ap.status::text ap_status,pr.status::text payment_status,pr.total_amount::text,pr.paid_amount::text,
   pr.journal_entry_id,h.accounting_status from public.vendor_invoices vi
   join public.mkt_ap_preparations ap on ap.vendor_invoice_id=vi.id
   join public.payment_requests pr on pr.mkt_ap_preparation_id=ap.id
   join public.mkt_accounting_handoffs h on h.payment_request_id=pr.id where vi.id=$1`,[refs.id]);
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({invoice_status:"ready_for_ap",three_way_match_status:"passed",
   ap_status:"waiting_payment",payment_status:"draft",total_amount:"100000.00",
   paid_amount:"0.00",journal_entry_id:null,accounting_status:"draft_not_posted"});
 });
 it("runs real invoice/AP service SQL, signed approval service, canonical bank post and finalizer in ONE isolated PG",async()=>{
  const refs=await runInvoiceAp();
  const signed:VerifiedActor={source:"signed_server_session",role:"super_admin",
    email:"owner@qa.invalid",companyId:1};
  const dialect=new PgDialect();
  const approvalClient=new pg.Client({connectionString:url});await approvalClient.connect();
  try{
   await approvalClient.query("BEGIN");
   const approved=await approveMarketplacePaymentRequest({
     execute:async(statement:any)=>{
       const q=dialect.sqlToQuery(statement);
       return approvalClient.query(q.sql,q.params) as any;
     },
   },signed,refs.requestId);
   expect(approved).toMatchObject({status:"approved",replay:false,bankTransfer:false,glPosted:false});
   await approvalClient.query("COMMIT");
  }catch(e){await approvalClient.query("ROLLBACK");throw e;}
  finally{await approvalClient.end();}

  const bankFixtureSql=`
   insert into public.bank_mutations
    (id,company_id,direction,status,accounting_posted,reconciliation_status,journal_entry_id,
     import_row_id,source_table,source_module,source_id,amount,bank_account_id,
     linked_transaction_type,linked_transaction_id)
    values(101,1,'OUT','unmatched',false,null,null,
     11,'public.vendor_invoices','bank_reconciliation',$1,100000,'BANK-1',
     'vendor_invoice_batch',$1);
   insert into public.bank_reconciliation_matches
    (id,mutation_id,candidate_type,candidate_source,candidate_id,status)
    values(501,101,'vendor_invoice','public.vendor_invoices',$1,'candidate');
   insert into public.payment_matching_groups(id,company_id,status,total_allocated,remaining_amount)
    values(301,1,'active',100000,0);
   insert into public.payment_allocations
    (id,group_id,company_id,invoice_id,mutation_id,allocated_amount,is_active)
    values(601,301,1,$1,101,100000,true);
   insert into public.accounting_entries(id,company_id,source,source_id,status,total_debit,total_credit)
    values(201,1,'bank_reconciliation',101,'draft',100000,100000);
   insert into public.accounting_entry_lines(id,entry_id,company_id,account_id,debit,credit)
    values(1,201,1,301,100000,0),(2,201,1,302,0,100000);
   insert into public.chart_of_accounts(id,company_id,is_active,is_postable)
    values(301,1,true,true),(302,1,true,true);
   insert into public.company_bank_accounts(id,company_id,account_number,coa_id,is_active)
    values(11,1,'BANK-1',302,true);
  `;
  for (const statement of bankFixtureSql.split(';').map(v=>v.trim()).filter(Boolean)) {
    await admin.query(statement,statement.includes('$1')?[refs.id]:[]);
  }
  // Run the actual Marketplace bank-admission guard against the AP chain.
  // The subsequent status/journal assignment is still a test fixture; the
  // full bank import+matching writer is not exercised by this isolated test.
  const gateClient=new pg.Client({connectionString:url});await gateClient.connect();
  try{
   await gateClient.query("BEGIN");
   const authorized=await authorizeMarketplaceReadyForApBankAllocation(
     gateClient,signed,1,refs.id,101);
   expect(authorized).toMatchObject({
     apId:refs.apId,requestId:refs.requestId,handoffId:refs.handoffId,
   });
   await gateClient.query("COMMIT");
  }catch(e){await gateClient.query("ROLLBACK");throw e;}
  finally{await gateClient.end();}
  await admin.query("update public.bank_mutations set status='approved_pending_posting',journal_entry_id=201 where id=101");
  const postClient=new pg.Client({connectionString:url});await postClient.connect();
  try{
   await postClient.query("BEGIN");
   const posted=await postBankMutationCanonical(postClient as never,101,201,501,
     {email:signed.email,companyId:1},{reason:"LOCALHOST FIXTURE IMPORT ONLY"});
   expect(posted).toMatchObject({status:"posted",idempotent:false,journal_entry_id:201});
   await postClient.query("COMMIT");
  }catch(e){await postClient.query("ROLLBACK");throw e;}
  finally{await postClient.end();}
  const c=new pg.Client({connectionString:url});await c.connect();
  try{
   expect((await finalizePostedMarketplacePayment(c,signed,refs.requestId,101)).status).toBe("CONFIRMED");
   expect((await finalizePostedMarketplacePayment(c,signed,refs.requestId,101)).status).toBe("REPLAY");
  }finally{await c.end();}
  const summary=await admin.query(`
   select pr.status::text payment_status,pr.paid_amount::text paid_amount,
     h.accounting_status, b.status bank_status,b.accounting_posted,
     ae.status journal_status,ae.total_debit::text debit,ae.total_credit::text credit,
     (select count(*)::int from public.mkt_payment_approval_audit_dev) approval_audits,
     (select count(*)::int from public.bank_reconciliation_audit) bank_audits,
     (select count(*)::int from public.audit_logs) finalization_audits
   from public.payment_requests pr
   join public.mkt_accounting_handoffs h on h.payment_request_id=pr.id
   join public.bank_mutations b on b.id=101
   join public.accounting_entries ae on ae.id=b.journal_entry_id
   where pr.id=$1`,[refs.requestId]);
  expect(summary.rows).toHaveLength(1);
  expect(summary.rows[0]).toMatchObject({
   payment_status:"paid",paid_amount:"100000.00",accounting_status:"posted",
   bank_status:"posted",accounting_posted:true,journal_status:"posted",
   debit:"100000",credit:"100000",
   approval_audits:1,bank_audits:1,finalization_audits:1,
  });
 });
 it("rejects changed unit price before inserting invoice",async()=>{
  const c=new pg.Client({connectionString:url});await c.connect();
  try{const scoped=drizzle(c,{schema});
   const bad=await createMarketplaceVendorInvoice({...invoiceInput,
    totalAmount:90000,grandTotal:90000,
    lines:[{...invoiceInput.lines[0],unitPrice:90000,subtotal:90000}]},vendor,scoped as never);
   expect(bad).toMatchObject({ok:false,code:"INVALID_LINE"});
  }finally{await c.end();}
  const r=await admin.query("select count(*)::int n from public.vendor_invoices");
  expect(r.rows[0].n).toBe(0);
 });
});
