import { describe,it,expect,beforeAll,afterAll,vi } from "vitest";
import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/node-postgres";
const state=vi.hoisted(()=>({db:null as any}));
vi.mock("@workspace/db",()=>({db:{transaction:(...args:any[])=>state.db.transaction(...args)}}));
vi.mock("../lib/logger.js",()=>({logger:{warn:vi.fn(),info:vi.fn()}}));
import { processOutboxBatch } from "../lib/accounting/outboxProcessor";
const url=process.env.CASH_QA_PG_URL;
const suite=url?describe:describe.skip;
suite("atomic outbox delivery on disposable PostgreSQL",()=>{
  let pool:any;
  beforeAll(async()=>{
    const u=new URL(url!);
    if(u.hostname!=="127.0.0.1"||u.port!=="55432"||u.pathname!=="/cash_qa"||u.username!=="cash_qa")throw Error("DISPOSABLE_DATABASE_REQUIRED");
    const {Pool}=createRequire(import.meta.url)("pg");
    pool=new Pool({connectionString:url,max:4,options:"-c search_path=outbox_qa"});
    await pool.query("create schema outbox_qa");
    await pool.query(`
      create table financial_outbox_events(id bigserial primary key,event_type text not null,payload jsonb not null,status text not null default 'pending',entry_id int,company_id int,attempt int not null default 0,last_error text,created_at timestamptz default now(),processed_at timestamptz);
      create table financial_events(id bigserial primary key,event_type text,company_id int,source_type text,source_id text,entry_id int,mutation_id int,amount numeric,actor text,ref text,meta jsonb);
      create function reject_delivery() returns trigger language plpgsql as $$begin
        if new.entry_id=997 then raise exception 'INJECTED_DELIVERY_FAILURE'; end if;
        return new;
      end$$;
      create trigger reject_delivery before insert on financial_events for each row execute function reject_delivery();
      create function reject_ack() returns trigger language plpgsql as $$begin
        if new.entry_id=998 and new.status='done' then raise exception 'INJECTED_ACK_FAILURE'; end if;
        return new;
      end$$;
      create trigger reject_ack before update on financial_outbox_events for each row execute function reject_ack();
    `);
    state.db=drizzle(pool);
  });
  afterAll(async()=>{if(pool){await pool.query("drop schema if exists outbox_qa cascade");await pool.end();}});
  async function add(entryId:number,companyId=1,payloadCompany=companyId){
    await pool.query("insert into financial_outbox_events(event_type,payload,entry_id,company_id) values('JOURNAL_CREATED',$1::jsonb,$2,$3)",[JSON.stringify({eventType:"JOURNAL_CREATED",entryId,companyId:payloadCompany,sourceType:"manual",sourceId:String(entryId),amount:10000}),entryId,companyId]);
  }
  async function status(entryId:number){
    return (await pool.query("select status,attempt,last_error,(select count(*)::int from financial_events f where f.entry_id=o.entry_id) delivered from financial_outbox_events o where entry_id=$1",[entryId])).rows[0];
  }
  it("two concurrent consumers deliver one durable event once",async()=>{
    await add(1);
    const counts=await Promise.all([processOutboxBatch(),processOutboxBatch()]);
    expect(counts.reduce((a,b)=>a+b,0)).toBe(1);
    expect(await status(1)).toMatchObject({status:"done",attempt:1,delivered:1});
    expect(await processOutboxBatch()).toBe(0);
  });
  it("failed financial insert remains pending with recorded retry",async()=>{
    await add(997);expect(await processOutboxBatch()).toBe(0);
    expect(await status(997)).toMatchObject({status:"pending",attempt:1,delivered:0,last_error:"OUTBOX_DELIVERY_FAILED"});
    for(let i=0;i<4;i++)await processOutboxBatch();
    expect(await processOutboxBatch()).toBe(0);
    expect(await status(997)).toMatchObject({attempt:5,delivered:0});
  });
  it("acknowledgment failure rolls back the inserted event",async()=>{
    await add(998);expect(await processOutboxBatch()).toBe(0);
    expect(await status(998)).toMatchObject({status:"pending",attempt:1,delivered:0});
    await pool.query("update financial_outbox_events set attempt=5 where entry_id=998");
  });
  it("rejects mismatched company without delivering an event",async()=>{
    await add(999,1,3);expect(await processOutboxBatch()).toBe(0);
    expect(await status(999)).toMatchObject({status:"pending",attempt:1,delivered:0});
  });
});
