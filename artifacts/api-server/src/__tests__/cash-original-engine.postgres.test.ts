import {describe,it,expect,beforeAll,afterAll,vi} from "vitest";
import {createRequire} from "node:module";
const state=vi.hoisted(()=>({pool:null as any,db:null as any}));
vi.mock("@workspace/db",async importOriginal=>{
  const original=await importOriginal<typeof import("@workspace/db")>();
  return {...original,pool:{connect:()=>state.pool.connect()},db:{
    execute:(...args:any[])=>state.db.execute(...args),
    select:(...args:any[])=>state.db.select(...args),
  }};
});
vi.mock("../lib/ledgerImmutability.js",()=>({lockAccountingEntry:vi.fn(async()=>{})}));
vi.mock("../lib/jobs/ledgerConsistencyCheck.js",()=>({scheduleSpotCheck:vi.fn()}));
import {drizzle} from "drizzle-orm/node-postgres";
import {CanonicalPostingEngine} from "../lib/posting-engine/CanonicalPostingEngine";
import type {PostingRequest} from "../lib/posting-engine/types";
const url=process.env.CASH_QA_PG_URL;
const suite=url?describe:describe.skip;
suite("original canonical posting engine: isolated PostgreSQL cash",()=>{
  let pool:any;
  let engine:CanonicalPostingEngine;
  beforeAll(async()=>{
    const u=new URL(url!);
    if(u.hostname!=="127.0.0.1"||u.port!=="55432"||u.pathname!=="/cash_qa"||u.username!=="cash_qa")throw Error("DISPOSABLE_DATABASE_REQUIRED");
    const {Pool}=createRequire(import.meta.url)("pg");
    pool=new Pool({connectionString:url,max:4,options:"-c search_path=cash_original_qa"});
    await pool.query("create schema cash_original_qa");
    await pool.query(`
      create table chart_of_accounts(id int primary key,company_id int,is_active boolean default true,is_postable boolean default true,is_header boolean default false,status text default 'ACTIVE',effective_from timestamp,effective_to timestamp);
      create table accounting_journals(id int primary key,company_id int);
      create table financial_periods(company_id int,year int,month int,is_closed boolean,override_allowed boolean);
      create table journal_sequences(journal_prefix text,company_id int,year int,next_seq int,primary key(journal_prefix,company_id,year));
      create table accounting_entries(
        id serial primary key,company_id int,entry_number text not null unique,journal_id int not null references accounting_journals(id),date date not null,
        ref text,description text,payment_method text,payment_provider text,bank_account_id text,status text not null,source text not null,source_id int,source_event_id text,
        total_debit numeric(14,2) not null,total_credit numeric(14,2) not null,created_by_id text,approved_by text,approved_at timestamp,cancelled_by text,cancelled_at timestamp,cancel_reason text,
        created_at timestamp default now(),cost_center_id int,facility_id int,expense_category text,branch_id int,division_id int,source_schema text,source_module text,source_table text,posted_at timestamp,voided_at timestamp,void_entry_id int,checksum_hash text,previous_entry_id int,voided_by text);
      create unique index qa_source on accounting_entries(company_id,source,source_id) where source<>'manual' and source_id is not null;
      create table accounting_entry_lines(id serial primary key,entry_id int not null references accounting_entries(id),account_id int not null references chart_of_accounts(id),description text,debit numeric(14,2),credit numeric(14,2));
      create table ledger_events(id serial primary key,company_id int,event_type text,period text,entry_id int,actor text,payload jsonb);
      create table financial_outbox_events(id bigserial primary key,event_type text,payload jsonb,entry_id int,company_id int,status text default 'pending');
      insert into chart_of_accounts(id,company_id) values(75839,1),(902,1),(903,3),(998,1);
      insert into accounting_journals values(9001,1);
      create function reject_line() returns trigger language plpgsql as $$begin
        if new.account_id=998 then raise exception 'QA_LINE_FAILURE'; end if; return new; end$$;
      create trigger reject_line before insert on accounting_entry_lines for each row execute function reject_line();
      create function reject_outbox() returns trigger language plpgsql as $$begin
        if new.payload->>'sourceId'='906' then raise exception 'QA_OUTBOX_FAILURE'; end if; return new; end$$;
      create trigger reject_outbox before insert on financial_outbox_events for each row execute function reject_outbox();
    `);
    state.pool=pool;state.db=drizzle(pool);engine=new CanonicalPostingEngine();
  });
  afterAll(async()=>{if(pool){await pool.query("drop schema if exists cash_original_qa cascade");await pool.end();}});
  // Synthetic existing source type for engine QA only; not a live Kas Besar source mapping.
  const req=(sourceId:number,out=false,contra=902):PostingRequest=>({companyId:1,source:"manual_payment",sourceId,journalId:9001,journalCode:"QA-CSH",date:new Date("2026-11-27T12:00:00Z"),lines:[{accountId:75839,debit:out?0:10000,credit:out?10000:0},{accountId:contra,debit:out?10000:0,credit:out?0:10000}]});
  async function counts(){return (await pool.query("select (select count(*)::int from accounting_entries) entries,(select count(*)::int from accounting_entry_lines) lines,(select count(*)::int from ledger_events) audit,(select count(*)::int from financial_outbox_events) outbox")).rows[0];}
  it("posts balanced IN and OUT with atomic checksum, audit and outbox",async()=>{
    for(const [id,out] of [[901,false],[902,true]] as const){
      const result=await engine.post(req(id,out));expect(result).toMatchObject({ok:true});
      const q=await pool.query("select e.status,e.checksum_hash,e.total_debit::text td,e.total_credit::text tc,l.debit::text dr,l.credit::text cr from accounting_entries e join accounting_entry_lines l on l.entry_id=e.id where e.source_id=$1 and l.account_id=75839",[id]);
      expect(q.rows[0]).toMatchObject({status:"posted",td:"10000.00",tc:"10000.00",dr:out?"0.00":"10000.00",cr:out?"10000.00":"0.00"});
      expect(q.rows[0].checksum_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(await counts()).toEqual({entries:2,lines:4,audit:2,outbox:2});
  });
  it("concurrent same-source replay leaves one journal",async()=>{
    const before=await counts();
    const both=await Promise.all([engine.post(req(903)),engine.post(req(903))]);
    expect(both[0]).toMatchObject({ok:true});expect(both[1]).toEqual(both[0]);
    expect(await counts()).toEqual({entries:before.entries+1,lines:before.lines+2,audit:before.audit+1,outbox:before.outbox+1});
  });
  it("rejects cross-company COA without writes",async()=>{
    const before=await counts();expect(await engine.post(req(904,false,903))).toMatchObject({ok:false,errorCode:"ACCOUNT_COMPANY_MISMATCH"});expect(await counts()).toEqual(before);
  });
  it("rolls back all artifacts on line or outbox failure",async()=>{
    const before=await counts();
    expect(await engine.post(req(905,false,998))).toMatchObject({ok:false,errorCode:"TRANSACTION_FAILED"});
    expect(await counts()).toEqual(before);
    expect(await engine.post(req(906))).toMatchObject({ok:false,errorCode:"TRANSACTION_FAILED"});
    expect(await counts()).toEqual(before);
  });
});
