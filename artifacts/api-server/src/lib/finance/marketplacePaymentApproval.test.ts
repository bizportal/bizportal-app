import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import pg from "pg";
import {PgDialect} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {approveMarketplacePaymentRequest} from "./marketplacePaymentApproval";
import type {VerifiedActor} from "./marketplacePaymentReleaseGate";
import fs from "node:fs";
import path from "node:path";
const url="postgres://postgres@127.0.0.1:55497/postgres";
const actor:VerifiedActor={source:"signed_server_session",role:"super_admin",email:"owner@qa.invalid",companyId:1};
let admin:pg.Client;
const dialect=new PgDialect();
function tx(client:pg.Client){
 return {execute:async(statement:any)=>{
  const q=dialect.sqlToQuery(statement);
  return client.query(q.sql,q.params) as any;
 }};
}
async function execute<T>(work:(db:ReturnType<typeof tx>)=>Promise<T>,
  company=1,failAudit=false,role="bizportal_finance_cst_login_dev"):Promise<T>{
 const c=new pg.Client({connectionString:url});await c.connect();
 try{
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE "+role);
  await c.query("select set_config('app.marketplace_company_id',$1,true)",[String(company)]);
  if(failAudit)await c.query("select set_config('qa.fail_approval_audit','true',true)");
  const value=await work(tx(c));
  await c.query("COMMIT");return value;
 }catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}
 finally{await c.end();}
}
async function snapshot(id=41){
 const r=await admin.query(`select pr.status,pr.paid_amount::text paid,pr.approved_by,
 (select count(*)::int from public.mkt_payment_approval_audit_dev a
   where a.payment_request_id=pr.id) audits
 from public.payment_requests pr where pr.id=$1`,[id]);
 return r.rows[0];
}
beforeAll(async()=>{
 admin=new pg.Client({connectionString:url});await admin.connect();
 await admin.query(`
 -- Disposable localhost QA database only: wipe previous fixture tables.
 drop schema if exists public cascade;
 create schema public;
 do $$
 begin
  if not exists(select 1 from pg_roles where rolname='bizportal_finance_cst_login_dev')
    then create role bizportal_finance_cst_login_dev NOLOGIN; end if;
  if not exists(select 1 from pg_roles where rolname='bizportal_finance_diva_login_dev')
    then create role bizportal_finance_diva_login_dev NOLOGIN; end if;
 end $$;
 create table public.vendor_invoices(
 id integer primary key,company_id integer,supplier_id integer,status text,three_way_match_status text,grand_total numeric);
 create table public.mkt_ap_preparations(
 id integer primary key,company_id integer,supplier_id integer,vendor_invoice_id integer,status text,grand_total_snapshot numeric);
 create table public.payment_requests(
 id integer primary key,company_id integer,supplier_id integer,status text,source_type text,
 source_id integer,mkt_ap_preparation_id integer,idempotency_key text,
 payload_fingerprint text,total_amount numeric,paid_amount numeric,journal_entry_id integer,
 approved_by text,approved_at timestamp,mkt_approved_by text,mkt_approved_at timestamp,
 mkt_treasury_ready_by text,mkt_treasury_ready_at timestamp,mkt_lifecycle_status text);
 create table public.mkt_accounting_handoffs(
 id integer primary key,company_id integer,payment_request_id integer,ap_preparation_id integer,
 vendor_invoice_id integer,status text,accounting_status text,payload_fingerprint text,handoff_key text,amount numeric);
 grant usage on schema public to bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
 grant select on public.vendor_invoices,public.mkt_ap_preparations,
 public.payment_requests,public.mkt_accounting_handoffs
 to bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
 alter table public.payment_requests enable row level security;
 create policy qa_select_pr on public.payment_requests for select
 to bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
 using(company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer);
 `);
 const migration=fs.readFileSync(path.resolve(import.meta.dirname,
  "../../../../../scripts/sql/20261120_dev_marketplace_payment_approval_REVIEW_ONLY.sql"),"utf8");
 await admin.query(migration);
 await admin.query(`
 create or replace function public.fail_approval_audit() returns trigger
 language plpgsql as $$
 begin
  if current_setting('qa.fail_approval_audit',true)='true'
   then raise exception 'QA_INJECTED_AUDIT_FAILURE'; end if;
  return new;
 end;$$;
 create trigger qa_fail_approval_audit before insert
 on public.mkt_payment_approval_audit_dev for each row execute function public.fail_approval_audit();
 `);
},30000);
afterAll(async()=>{await admin?.end();});
beforeEach(async()=>{
 await admin.query(`
 truncate public.mkt_payment_approval_audit_dev,public.payment_requests,
 public.mkt_accounting_handoffs,public.mkt_ap_preparations,public.vendor_invoices
 restart identity cascade;
 insert into public.vendor_invoices values(77,1,5,'ready_for_ap','passed',100),(78,3,5,'ready_for_ap','passed',100);
 insert into public.mkt_ap_preparations values(88,1,5,77,'waiting_payment',100),(89,3,5,78,'waiting_payment',100);
 insert into public.payment_requests
 (id,company_id,supplier_id,status,source_type,source_id,mkt_ap_preparation_id,
 idempotency_key,payload_fingerprint,total_amount,paid_amount,journal_entry_id)
 values(41,1,5,'draft','marketplace_ap',88,88,'mkt-ap:88',repeat('a',64),100,0,null),
 (42,3,5,'draft','marketplace_ap',89,89,'mkt-ap:89',repeat('b',64),100,0,null);
 insert into public.mkt_accounting_handoffs
 values(9,1,41,88,77,'accepted','draft_not_posted',repeat('a',64),'mkt-ap:88',100),
 (10,3,42,89,78,'accepted','draft_not_posted',repeat('b',64),'mkt-ap:89',100);
 `);
});
describe("real DEV Finance company scoped approval role and PostgreSQL transaction",()=>{
 it("approves once, writes audit atomically, never marks paid or posted",async()=>{
  expect(await execute(db=>approveMarketplacePaymentRequest(db,actor,41)))
    .toMatchObject({requestId:41,status:"approved",replay:false,bankTransfer:false,glPosted:false});
  expect(await execute(db=>approveMarketplacePaymentRequest(db,actor,41)))
    .toMatchObject({replay:true});
  expect(await snapshot()).toMatchObject({status:"approved",paid:"0",approved_by:"owner@qa.invalid",audits:1});
 });
 it("serializes concurrent approvals with exactly one audit row",async()=>{
  const result=await Promise.all([
    execute(db=>approveMarketplacePaymentRequest(db,actor,41)),
    execute(db=>approveMarketplacePaymentRequest(db,actor,41)),
  ]);
  expect(result.map(x=>x.replay).sort()).toEqual([false,true]);
  expect((await snapshot()).audits).toBe(1);
 });
 it("rolls back status when audit insert fails",async()=>{
  await expect(execute(db=>approveMarketplacePaymentRequest(db,actor,41),1,true))
    .rejects.toThrow("QA_INJECTED_AUDIT_FAILURE");
  expect(await snapshot()).toMatchObject({status:"draft",paid:"0",approved_by:null,audits:0});
 });
 it("rejects cross-company, anonymous and non-superadmin",async()=>{
  await expect(execute(db=>approveMarketplacePaymentRequest(db,{...actor,companyId:3},41)))
    .rejects.toThrow("COMPANY_SCOPE_FORBIDDEN");
  await expect(execute(db=>approveMarketplacePaymentRequest(db,actor,42)))
    .rejects.toThrow("PAYMENT_CHAIN_NOT_FOUND");
  await expect(execute(db=>approveMarketplacePaymentRequest(db,{...actor,role:"super_admin",source:"signed_server_session",email:""},41)))
    .rejects.toThrow("SIGNED_SUPERADMIN_REQUIRED");
 });
 it("blocks a changed invoice or handoff amount before approval",async()=>{
  await admin.query("update public.vendor_invoices set grand_total=101 where id=77");
  await expect(execute(db=>approveMarketplacePaymentRequest(db,actor,41)))
    .rejects.toThrow("AMOUNT_SNAPSHOT_MISMATCH");
  await admin.query("update public.vendor_invoices set grand_total=100 where id=77");
  await admin.query("update public.mkt_accounting_handoffs set amount=101 where id=9");
  await expect(execute(db=>approveMarketplacePaymentRequest(db,actor,41)))
    .rejects.toThrow("AMOUNT_SNAPSHOT_MISMATCH");
  expect((await snapshot()).status).toBe("draft");
 });
 it("does not grant role permission to modify payment total or paid amount",async()=>{
  await expect(execute(db=>db.execute(sql`
    update public.payment_requests set total_amount=999 where id=41
  `))).rejects.toThrow();
  await expect(execute(db=>db.execute(sql`
    update public.payment_requests set paid_amount=100 where id=41
  `))).rejects.toThrow();
  expect(await snapshot()).toMatchObject({status:"draft",paid:"0",audits:0});
 });
 it("rejects payment update to paid without any permission",async()=>{
  await expect(execute(db=>db.execute(
    sql`update public.payment_requests set status='paid' where id=41`
  ))).rejects.toThrow();
  expect(await snapshot()).toMatchObject({status:"draft",paid:"0",audits:0});
 });
});
