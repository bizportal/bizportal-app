import {beforeAll,afterAll,beforeEach,describe,expect,it} from "vitest";
import pg from "pg";
import {PgDialect} from "drizzle-orm/pg-core";
import {approveMarketplacePaymentRequest} from "./marketplacePaymentApproval";
import {finalizePostedMarketplacePayment} from "./marketplacePaymentFinalization";
import type {VerifiedActor} from "./marketplacePaymentReleaseGate";
const url="postgres://postgres@127.0.0.1:55493/postgres";
const actor:VerifiedActor={source:"signed_server_session",role:"super_admin",email:"owner@example.invalid",companyId:1};
let admin:pg.Client;
beforeAll(async()=>{
 admin=new pg.Client({connectionString:url});
 await admin.connect();
 await admin.query(`
   -- Disposable container only: reset the prior test's fixture schema.
   drop table if exists public.mkt_payment_approval_audit_dev;
   drop table if exists public.audit_logs;
   drop table if exists public.company_bank_accounts;
   drop table if exists public.chart_of_accounts;
   drop table if exists public.accounting_entry_lines;
   drop table if exists public.accounting_entries;
   drop table if exists public.payment_allocations;
   drop table if exists public.payment_matching_groups;
   drop table if exists public.bank_reconciliation_matches;
   drop table if exists public.bank_mutations;
   drop table if exists public.mkt_accounting_handoffs;
   drop table if exists public.mkt_ap_preparations;
   drop table if exists public.vendor_invoices;
   drop table if exists public.payment_requests;
   create table public.payment_requests(
      id integer primary key,company_id integer,source_type text,source_id integer,
      mkt_ap_preparation_id integer,idempotency_key text,status text,
      approved_by text,approved_at timestamp,mkt_approved_at timestamp,mkt_treasury_ready_at timestamp,
      mkt_approved_by text,mkt_treasury_ready_by text,mkt_lifecycle_status text,
      supplier_id integer,total_amount numeric,paid_amount numeric,journal_entry_id integer,
      mkt_completed_at timestamp,updated_at timestamp,payload_fingerprint text
   );
   create table public.mkt_accounting_handoffs(
     id integer primary key,payment_request_id integer,company_id integer,
     vendor_invoice_id integer,ap_preparation_id integer,
     status text,accounting_status text,accounting_reference text,
     handoff_key text,amount numeric,payload_fingerprint text,updated_at timestamp
   );
   create table public.mkt_ap_preparations(
     id integer primary key,company_id integer,vendor_invoice_id integer,supplier_id integer,status text,grand_total_snapshot numeric
   );
   create table public.vendor_invoices(
     id integer primary key,company_id integer,supplier_id integer,status text,three_way_match_status text,grand_total numeric
   );
   create table public.bank_mutations(
     id integer primary key,company_id integer,direction text,status text,
     accounting_posted boolean,reconciliation_status text,journal_entry_id integer,
     import_row_id integer,import_batch_id integer,source_table text,source_module text,
     source_id integer,linked_transaction_type text,linked_transaction_id integer,
     amount numeric,bank_account_id text,approved_at timestamptz
   );
   create table public.payment_matching_groups(
     id integer primary key, company_id integer,status text,
     total_allocated numeric,remaining_amount numeric
   );
   create table public.payment_allocations(
     id integer primary key,group_id integer,company_id integer,
     invoice_id integer,mutation_id integer,allocated_amount numeric,
     is_active boolean
   );
   create table public.bank_reconciliation_matches(
     id integer primary key,mutation_id integer,candidate_type text,
     candidate_source text,candidate_id text,status text
   );
   create table public.accounting_entries(
     id integer primary key,company_id integer,source text,source_id integer,
     status text,total_debit numeric,total_credit numeric
   );
   create table public.accounting_entry_lines(
     id integer primary key,entry_id integer,company_id integer,
     account_id integer,debit numeric,credit numeric
   );
   create table public.company_bank_accounts(
     id integer primary key,company_id integer,account_number text,coa_id integer,is_active boolean
   );
   create table public.chart_of_accounts(
     id integer primary key,company_id integer,is_active boolean,is_postable boolean
   );
   create table public.mkt_payment_approval_audit_dev(
     id serial primary key,company_id integer,payment_request_id integer,
     actor_email text,decision text,created_at timestamptz default now(),
     unique(payment_request_id)
   );
   create table public.audit_logs(
     id serial primary key,user_email text,action text,entity_type text,entity_id text,
     company_id text,module text,after_data jsonb
   );
   create or replace function public.qa_fail_audit() returns trigger as $$
   begin
     if current_setting('qa.fail_audit',true)='true' then
       raise exception 'QA_INJECTED_AUDIT_FAILURE';
     end if;
     return new;
   end;$$ language plpgsql;
   create trigger fail_final_audit before insert on public.audit_logs
     for each row execute function public.qa_fail_audit();
 `);
},30000);
afterAll(async()=>{await admin.end()});
beforeEach(async()=>{
 await admin.query(`truncate public.mkt_payment_approval_audit_dev,
 public.company_bank_accounts,public.chart_of_accounts,
 public.audit_logs,public.accounting_entry_lines,
 public.accounting_entries,public.payment_allocations,public.payment_matching_groups,
 public.bank_reconciliation_matches,public.bank_mutations,
 public.vendor_invoices,public.mkt_ap_preparations,public.mkt_accounting_handoffs,
 public.payment_requests restart identity`);
 await admin.query(`
 insert into public.payment_requests
  (id,company_id,source_type,source_id,mkt_ap_preparation_id,idempotency_key,
   status,approved_by,approved_at,mkt_approved_at,mkt_treasury_ready_at,supplier_id,
   total_amount,paid_amount,journal_entry_id,payload_fingerprint)
 values (41,1,'marketplace_ap',88,88,'mkt-ap:88','approved',
   'owner@example.invalid',now(),now(),now(),5,100.00,0,null,repeat('a',64));
 insert into public.mkt_accounting_handoffs
  (id,payment_request_id,company_id,vendor_invoice_id,ap_preparation_id,status,
   accounting_status,handoff_key,amount,payload_fingerprint)
 values (9,41,1,77,88,'accepted','draft_not_posted','mkt-ap:88',100,repeat('a',64));
 insert into public.mkt_ap_preparations(id,company_id,vendor_invoice_id,supplier_id,status,grand_total_snapshot)
 values (88,1,77,5,'waiting_payment',100);
 insert into public.vendor_invoices(id,company_id,supplier_id,status,three_way_match_status,grand_total)
 values (77,1,5,'ready_for_ap','passed',100);
 insert into public.bank_mutations
 (id,company_id,direction,status,accounting_posted,reconciliation_status,
 journal_entry_id,import_row_id,source_table,source_module,source_id,amount,
 bank_account_id,approved_at,linked_transaction_type,linked_transaction_id)
 values(101,1,'OUT','posted',true,'reconciled',201,11,'public.vendor_invoices',
 'bank_reconciliation',77,100.00,'BANK-1',now(),'vendor_invoice_batch',77);
 insert into public.bank_reconciliation_matches
 (id,mutation_id,candidate_type,candidate_source,candidate_id,status)
 values(501,101,'vendor_invoice','public.vendor_invoices','77','approved');
 insert into public.payment_matching_groups(id,company_id,status,total_allocated,remaining_amount)
 values(301,1,'active',100,0);
 insert into public.payment_allocations(id,group_id,company_id,invoice_id,mutation_id,allocated_amount,is_active)
 values(601,301,1,77,101,100,true);
 insert into public.accounting_entries
 (id,company_id,source,source_id,status,total_debit,total_credit)
 values(201,1,'bank_reconciliation',101,'posted',100,100);
 insert into public.accounting_entry_lines(id,entry_id,company_id,account_id,debit,credit)
 values(1,201,1,301,100,0),(2,201,1,302,0,100);
 insert into public.chart_of_accounts(id,company_id,is_active,is_postable)
 values(302,1,true,true),(301,1,true,true);
 insert into public.company_bank_accounts(id,company_id,account_number,coa_id,is_active)
 values(11,1,'BANK-1',302,true);
 `);
});
async function run(requestId=41,bankId=101,who:VerifiedActor=actor,fail=false){
 const c=new pg.Client({connectionString:url});
 await c.connect();
 try{
   if(fail)await c.query("select set_config('qa.fail_audit','true',false)");
   return await finalizePostedMarketplacePayment(c,who,requestId,bankId);
 }finally{await c.end();}
}
async function snapshot(){
 const x=await admin.query(`select
 (select status from public.payment_requests where id=41) request_status,
 (select paid_amount::text from public.payment_requests where id=41) paid,
 (select journal_entry_id from public.payment_requests where id=41) journal_id,
 (select accounting_status from public.mkt_accounting_handoffs where id=9) handoff_status,
 (select count(*)::int from public.audit_logs) audit_count`);
 return x.rows[0];
}
describe("Marketplace Approval to posted-bank finalization integrated PostgreSQL flow",()=>{
 it("approves actual AP draft, then finalizes matched posted bank evidence with one audit each",async()=>{
   // Existing canonical bank evidence fixture is already posted. These tests
   // prove approval+finalization composition, not the bank posting algorithm.
   await admin.query(`update public.payment_requests set
     status='draft',approved_by=null,approved_at=null,mkt_approved_at=null,
     mkt_treasury_ready_at=null where id=41`);
   const c=new pg.Client({connectionString:url});await c.connect();
   const dialect=new PgDialect();
   try{
     await c.query("BEGIN");
     const approved=await approveMarketplacePaymentRequest({
       execute:async(statement:any)=>{
         const q=dialect.sqlToQuery(statement);
         return c.query(q.sql,q.params) as any;
       },
     },actor,41);
     expect(approved).toMatchObject({status:"approved",replay:false,bankTransfer:false,glPosted:false});
     await c.query("COMMIT");
   }finally{await c.end();}
   expect((await admin.query("select status from public.payment_requests where id=41")).rows[0].status)
     .toBe("approved");
   const first=await run();
   expect(first.status).toBe("CONFIRMED");
   expect((await run()).status).toBe("REPLAY");
   expect(await snapshot()).toMatchObject({
     request_status:"paid",paid:"100.00",journal_id:201,
     handoff_status:"posted",audit_count:1,
   });
   const approvalAudits=await admin.query(
     "select count(*)::int as count from public.mkt_payment_approval_audit_dev where payment_request_id=41");
   expect(approvalAudits.rows[0].count).toBe(1);
 });
 it("refuses finalization of a draft request lacking an authenticated approval",async()=>{
   await admin.query("update public.payment_requests set status='draft',approved_by=null,approved_at=null where id=41");
   await expect(run()).rejects.toThrow("SIGNED_APPROVAL_MISSING");
   expect(await snapshot()).toMatchObject({
     request_status:"draft",paid:"0",journal_id:null,handoff_status:"draft_not_posted",audit_count:0,
   });
 });
});
describe("Marketplace AP posted bank atomic finalization, disposable PostgreSQL only",()=>{
 it("confirms a verified payment exactly once and replays without duplicate audit",async()=>{
  expect((await run()).status).toBe("CONFIRMED");
  expect((await run()).status).toBe("REPLAY");
  expect(await snapshot()).toMatchObject({request_status:"paid",paid:"100.00",
    journal_id:201,handoff_status:"posted",audit_count:1});
 });
 it("serializes concurrent confirmations into one audit and idempotent replay",async()=>{
  const results=await Promise.all([run(),run()]);
  expect(results.map(r=>r.status).sort()).toEqual(["CONFIRMED","REPLAY"]);
  expect(await snapshot()).toMatchObject({request_status:"paid",paid:"100.00",
    journal_id:201,handoff_status:"posted",audit_count:1});
 });
 it("rolls back both updates after injected audit failure",async()=>{
  await expect(run(41,101,actor,true)).rejects.toThrow("QA_INJECTED_AUDIT_FAILURE");
  expect(await snapshot()).toMatchObject({request_status:"approved",paid:"0",
    journal_id:null,handoff_status:"draft_not_posted",audit_count:0});
 });
 it("rejects unsigned or cross-company Super Admin before update",async()=>{
  await expect(run(41,101,{...actor,companyId:3})).rejects.toThrow("COMPANY_SCOPE_FORBIDDEN");
  await expect(run(41,101,{...actor,source:"signed_server_session",role:"super_admin",approvedGlobalCompanyId:1,companyId:3}))
    .rejects.toThrow("COMPANY_SCOPE_FORBIDDEN");
  expect((await snapshot()).audit_count).toBe(0);
 });
 it("rejects wrong bank identity, and rejects a non-imported bank row",async()=>{
  await admin.query("update public.bank_mutations set linked_transaction_id=42 where id=101");
  await expect(run()).rejects.toThrow("NATIVE_VENDOR_BANK_LINK_INVALID");
  await admin.query("update public.bank_mutations set linked_transaction_id=77,import_row_id=null where id=101");
  await expect(run()).rejects.toThrow("BANK_NOT_POSTED_FROM_IMPORT");
  expect((await snapshot()).audit_count).toBe(0);
 });
 it("rejects mismatched journal totals, invalid approval, and missing match",async()=>{
  await admin.query("update public.accounting_entry_lines set credit=99 where id=2");
  await expect(run()).rejects.toThrow("UNBALANCED_JOURNAL");
  await admin.query("update public.accounting_entry_lines set credit=100 where id=2");
  await admin.query("update public.payment_requests set approved_at=null where id=41");
  await expect(run()).rejects.toThrow("SIGNED_APPROVAL_MISSING");
  await admin.query("update public.payment_requests set approved_at=now() where id=41");
  await admin.query("delete from public.bank_reconciliation_matches where id=501");
  await expect(run()).rejects.toThrow("NATIVE_VENDOR_MATCH_INVALID");
 });
 it("rejects competing final bank matches and changed amount",async()=>{
  await admin.query("insert into public.payment_matching_groups values (302,1,'active',100,0)");
  await admin.query("insert into public.payment_allocations values (602,302,1,77,999,100,true)");
  await admin.query(`insert into public.bank_mutations
    (id,company_id,direction,status,accounting_posted,reconciliation_status,journal_entry_id,amount)
    values(999,1,'OUT','posted',true,'reconciled',999,100)`);
  await expect(run()).rejects.toThrow("COMPETING_VENDOR_ALLOCATION");
  await admin.query("delete from public.payment_allocations where id=602");
  await admin.query("delete from public.bank_mutations where id=999");
  await admin.query("update public.bank_mutations set amount=101 where id=101");
  await expect(run()).rejects.toThrow("NATIVE_BANK_ALLOCATION_MISMATCH");
 });
 it("rejects multi-invoice allocation and mismatched matching group",async()=>{
   await admin.query("insert into public.payment_allocations values(602,301,1,78,101,100,true)");
   await expect(run()).rejects.toThrow("MULTI_INVOICE_PAYMENT_BATCH_UNSUPPORTED");
   await admin.query("delete from public.payment_allocations where id=602");
   await admin.query("update public.payment_matching_groups set company_id=3 where id=301");
   await expect(run()).rejects.toThrow("NATIVE_BANK_ALLOCATION_MISMATCH");
 });
 it("rejects a payment matching group shared with a second mutation",async()=>{
   await admin.query("insert into public.payment_allocations values(602,301,1,78,999,1,true)");
   await expect(run()).rejects.toThrow("SHARED_PAYMENT_GROUP_UNSUPPORTED");
 });
 it("rejects a manually changed Invoice state after the guarded AP allocation",async()=>{
   await admin.query("update public.vendor_invoices set status='draft' where id=77");
   await expect(run()).rejects.toThrow("AP_INVOICE_NOT_READY");
 });
 it("rejects inactive bank mapping and cross-company COA",async()=>{
   await admin.query("update public.company_bank_accounts set is_active=false where id=11");
   await expect(run()).rejects.toThrow("ACTIVE_COMPANY_BANK_COA_REQUIRED");
   await admin.query("update public.company_bank_accounts set is_active=true where id=11");
   await admin.query("update public.chart_of_accounts set company_id=3 where id=302");
   await expect(run()).rejects.toThrow("ACTIVE_COMPANY_BANK_COA_REQUIRED");
 });
 it("rejects journal without an outgoing credit to the mapped bank COA",async()=>{
   await admin.query("update public.company_bank_accounts set coa_id=301 where id=11");
   await expect(run()).rejects.toThrow("BANK_COA_CREDIT_MISSING");
 });
 it("never marks unposted journal/previous draft payment as completed",async()=>{
  await admin.query("update public.accounting_entries set status='draft' where id=201");
  await expect(run()).rejects.toThrow("CANONICAL_POSTED_JOURNAL_REQUIRED");
  await admin.query("update public.accounting_entries set status='posted' where id=201");
  await admin.query("update public.payment_requests set status='draft' where id=41");
  await expect(run()).rejects.toThrow("REQUEST_NOT_READY");
 });
});
