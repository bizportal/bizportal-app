import {beforeAll,afterAll,beforeEach,afterEach,describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import pg from "pg";
import {authorizeMarketplaceReadyForApBankAllocation} from "./marketplaceInvoiceBankStatusAdapter";
import type {VerifiedActor} from "./marketplacePaymentReleaseGate";
const url="postgres://postgres@127.0.0.1:55494/postgres";
let client:pg.Client;
const owner:VerifiedActor={source:"signed_server_session",role:"super_admin",email:"owner@example.invalid",companyId:1};
const action=(actor:VerifiedActor|null=owner,company=1,invoice=77,bank=101)=>
  authorizeMarketplaceReadyForApBankAllocation(client,actor,company,invoice,bank);
beforeAll(async()=>{
 client=new pg.Client({connectionString:url});await client.connect();
 await client.query(`
 -- The disposable QA container may be reused by a second run. Never use
 -- this test against a real Supabase connection.
 drop table if exists public.mkt_accounting_handoffs;
 drop table if exists public.payment_requests;
 drop table if exists public.mkt_ap_preparations;
 drop table if exists public.vendor_invoices;
 drop table if exists public.bank_mutations;
 drop table if exists public.bank_sheet_configs;
 drop table if exists public.company_bank_accounts;
 create table public.vendor_invoices(
   id integer primary key,company_id integer,supplier_id integer,
   status text,three_way_match_status text
 );
 create table public.mkt_ap_preparations(
   id integer primary key,company_id integer,supplier_id integer,vendor_invoice_id integer,status text
 );
 create table public.payment_requests(
   id integer primary key,mkt_ap_preparation_id integer,source_id integer,source_type text,
   company_id integer,supplier_id integer,status text,
   approved_by text,approved_at timestamptz,mkt_approved_at timestamptz,
   mkt_treasury_ready_at timestamptz,total_amount numeric,paid_amount numeric,
   journal_entry_id integer,idempotency_key text,payload_fingerprint text
 );
 create table public.mkt_accounting_handoffs(
   id integer primary key,ap_preparation_id integer,vendor_invoice_id integer,
   company_id integer,payment_request_id integer,status text,accounting_status text,
   payload_fingerprint text
 );
 create table public.bank_mutations(
   id integer primary key,company_id integer,amount numeric,
   direction text,status text,journal_entry_id integer,import_row_id integer,
   import_batch_id integer,source text,source_classification text,
   sheet_config_id integer,bank_account_id text,canonical_key text,
   transaction_date date,description text,debit_amount numeric,credit_amount numeric
 );
 create table public.bank_sheet_configs(
   id integer primary key,company_id integer,bank_account_id integer,
   is_active boolean,sheet_id text,tab_name text
 );
 create table public.company_bank_accounts(
   id integer primary key,company_id integer,is_active boolean,account_type text default 'bank'
 );
 `);
});
afterAll(async()=>{await client.end()});
afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await client.query(`truncate public.vendor_invoices,public.mkt_ap_preparations,
 public.payment_requests,public.mkt_accounting_handoffs,public.bank_mutations,
 public.bank_sheet_configs,public.company_bank_accounts;
 insert into public.vendor_invoices values(77,1,5,'ready_for_ap','passed');
 insert into public.mkt_ap_preparations values(88,1,5,77,'waiting_payment');
 insert into public.payment_requests values
 (41,88,88,'marketplace_ap',1,5,'approved','owner@example.invalid',
 now(),now(),now(),100,0,null,'mkt-ap:88',repeat('a',64));
 insert into public.mkt_accounting_handoffs values
 (9,88,77,1,41,'accepted','draft_not_posted',repeat('a',64));
 insert into public.bank_mutations
 (id,company_id,amount,direction,status,journal_entry_id,import_row_id,import_batch_id)
 values(101,1,100,'OUT','unmatched',null,19,null);
 `);
});
async function sheetImportedRow(){
 vi.stubEnv("APP_ENV","development");
 vi.stubEnv("BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV","true");
 const canonical=createHash("sha256").update("1|11|2026-11-25|10000|0|PO14 VENDOR PAYMENT").digest("hex");
 await client.query(`
 insert into public.bank_sheet_configs values(3,1,11,true,'isolated-sheet','mutasidev');
 insert into public.company_bank_accounts(id,company_id,is_active) values(11,1,true);
 `);
 await client.query(`update public.bank_mutations set import_row_id=null,
 source='google_sheet',source_classification='actual_bank_mutation',sheet_config_id=3,
 bank_account_id='11',canonical_key=$1,transaction_date='2026-11-25',
 description='PO14 Vendor Payment',debit_amount=100,credit_amount=0 where id=101`,[canonical]);
}
describe("Marketplace AP bank-status adapter real PostgreSQL admission (no financial writes)",()=>{
 it("admits exact owner, company and verified AP-to-request evidence",async()=>{
  expect(await action()).toEqual({apId:88,requestId:41,handoffId:9});
 });
 it("denies absent signed identity or wrong company",async()=>{
  await expect(action(null)).rejects.toThrow("SIGNED_SUPERADMIN_REQUIRED");
  await expect(action({...owner,companyId:3})).rejects.toThrow("COMPANY_SCOPE_FORBIDDEN");
  await expect(action(owner,3)).rejects.toThrow("COMPANY_SCOPE_FORBIDDEN");
 });
 it("does not let company-bound actor use global selection to cross company",async()=>{
  await expect(action({...owner,companyId:3,approvedGlobalCompanyId:1})).rejects.toThrow("COMPANY_SCOPE_FORBIDDEN");
 });
 it("denies fake or missing approval, including missing Treasury",async()=>{
  await client.query("update public.payment_requests set approved_by='another@example.invalid' where id=41");
  await expect(action()).rejects.toThrow("SIGNED_APPROVAL_OR_TREASURY_MISSING");
  await client.query("update public.payment_requests set approved_by='owner@example.invalid',mkt_treasury_ready_at=null where id=41");
  await expect(action()).rejects.toThrow("SIGNED_APPROVAL_OR_TREASURY_MISSING");
 });
 it("denies replay of already-paid Payment Request and changed idempotency",async()=>{
  await client.query("update public.payment_requests set paid_amount=100 where id=41");
  await expect(action()).rejects.toThrow("REQUEST_ALREADY_USED_OR_NOT_APPROVED");
  await client.query("update public.payment_requests set paid_amount=0,idempotency_key='wrong' where id=41");
  await expect(action()).rejects.toThrow("HANDOFF_FINGERPRINT_INVALID");
 });
 it("denies wrong bank amount and wrong direction",async()=>{
  await client.query("update public.bank_mutations set amount=99 where id=101");
  await expect(action()).rejects.toThrow("BANK_AMOUNT_MISMATCH");
  await client.query("update public.bank_mutations set amount=100,direction='IN' where id=101");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
 });
 it("denies a bank mutation without real import provenance",async()=>{
  await client.query("update public.bank_mutations set import_row_id=null where id=101");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
 });
 it("denies bank mutation already approved/posted or journal already bound",async()=>{
  await client.query("update public.bank_mutations set status='posted' where id=101");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
  await client.query("update public.bank_mutations set status='unmatched',journal_entry_id=201 where id=101");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
 });
 it("never authorizes Invoice draft, posted or cross-company AP",async()=>{
  await client.query("update public.vendor_invoices set status='draft' where id=77");
  await expect(action()).rejects.toThrow("AP_BANK_CHAIN_NOT_FOUND");
  await client.query("update public.vendor_invoices set status='ready_for_ap' where id=77");
  await client.query("update public.mkt_ap_preparations set company_id=3 where id=88");
  await expect(action()).rejects.toThrow("AP_BANK_CHAIN_NOT_FOUND");
 });
 it("rejects amended invoice supplier, handoff fingerprint and missing PO-link state",async()=>{
  await client.query("update public.vendor_invoices set supplier_id=6 where id=77");
  await expect(action()).rejects.toThrow("AP_BANK_CHAIN_NOT_FOUND");
  await client.query("update public.vendor_invoices set supplier_id=5 where id=77");
  await client.query("update public.mkt_accounting_handoffs set payload_fingerprint=repeat('b',64) where id=9");
  await expect(action()).rejects.toThrow("HANDOFF_FINGERPRINT_INVALID");
  await client.query("update public.mkt_accounting_handoffs set payload_fingerprint=repeat('a',64) where id=9");
  await client.query("update public.mkt_ap_preparations set status='finance_review' where id=88");
  await expect(action()).rejects.toThrow("AP_BANK_CHAIN_NOT_FOUND");
 });
 it("does not mutate ANY financial row on successful admission",async()=>{
  const before=(await client.query("select row_to_json(r) as value from public.payment_requests r where id=41")).rows[0].value;
  const admitted=await action();
  const after=(await client.query("select row_to_json(r) as value from public.payment_requests r where id=41")).rows[0].value;
  expect(admitted.requestId).toBe(41); expect(after).toEqual(before);
 });
 it("admits the actual Sheet importer provenance without inventing statement import IDs",async()=>{
  await sheetImportedRow();
  expect(await action()).toEqual({apId:88,requestId:41,handoffId:9});
  const bank=(await client.query("select import_row_id,import_batch_id,source,status from public.bank_mutations where id=101")).rows[0];
  expect(bank).toEqual({import_row_id:null,import_batch_id:null,source:"google_sheet",status:"unmatched"});
 });
 it("does not enable Sheet provenance outside the opted-in DEV adapter",async()=>{
  await sheetImportedRow();
  vi.stubEnv("APP_ENV","production");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
  vi.stubEnv("APP_ENV","development");
  vi.stubEnv("BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV","false");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
 });
 it("rejects a Sheet provenance edit even when an unrelated import ID is added",async()=>{
  await sheetImportedRow();
  await client.query("update public.bank_mutations set canonical_key=repeat('b',64),import_row_id=19 where id=101");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
 });
 it("requires the Sheet config, bank account and mutation to belong to the same company",async()=>{
  await sheetImportedRow();
  await client.query("update public.bank_sheet_configs set company_id=3 where id=3");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
  await client.query("update public.bank_sheet_configs set company_id=1 where id=3");
  await client.query("update public.company_bank_accounts set company_id=3 where id=11");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
 });
 it("rejects disabled Sheet or bank sources and ambiguous debit-credit rows",async()=>{
  await sheetImportedRow();
  await client.query("update public.bank_sheet_configs set is_active=false where id=3");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
  await client.query("update public.bank_sheet_configs set is_active=true where id=3");
  await client.query("update public.company_bank_accounts set is_active=false where id=11");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
  await client.query("update public.company_bank_accounts set is_active=true where id=11");
  await client.query("update public.bank_mutations set credit_amount=100 where id=101");
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
 });
 it("rejects an inbound statement row relabeled OUT or an amount inconsistent with the imported debit",async()=>{
  await sheetImportedRow();
  const incoming=createHash("sha256").update("1|11|2026-11-25|0|10000|PO14 VENDOR PAYMENT").digest("hex");
  await client.query("update public.bank_mutations set debit_amount=0,credit_amount=100,canonical_key=$1 where id=101",[incoming]);
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
  const wrongAmount=createHash("sha256").update("1|11|2026-11-25|10100|0|PO14 VENDOR PAYMENT").digest("hex");
  await client.query("update public.bank_mutations set debit_amount=101,credit_amount=0,canonical_key=$1 where id=101",[wrongAmount]);
  await expect(action()).rejects.toThrow("BANK_MUTATION_NOT_ELIGIBLE");
 });
});
