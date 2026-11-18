import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { assertOutboundSourceBankCoa } from "../lib/outboundReuseBankCoaGate";
import type { OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

const url=process.env.PR95_ATOMIC_PG_URL;
const suite=url?describe:describe.skip;
const scope={companyId:1,mutationId:90001,entryId:314,amountMinor:10000};

suite("PR95 bank COA evidence on disposable PostgreSQL 16",()=>{
  let client:pg.Client;
  beforeAll(async()=>{
    const u=new URL(url!);
    if(u.hostname!=="127.0.0.1"||u.port!=="65433"||u.pathname!=="/pr95_ci"
      ||u.username!=="postgres.xssrfshdrtdfupgqwfdw") throw Error("NON_DISPOSABLE_DB_REFUSED");
    client=new pg.Client({connectionString:url});
    await client.connect();
    await client.query(`
      CREATE TABLE public.bank_mutations(id integer primary key,company_id integer,bank_account_id text);
      CREATE TABLE public.company_bank_accounts(id integer primary key,company_id integer,coa_id integer,is_active boolean);
      CREATE TABLE public.chart_of_accounts(id integer primary key,company_id integer,is_active boolean);
      CREATE TABLE public.accounting_entry_lines(id integer primary key,entry_id integer,account_id integer,debit numeric,credit numeric);
      INSERT INTO public.bank_mutations VALUES(90001,1,'17');
      INSERT INTO public.company_bank_accounts VALUES(17,1,1023,true);
      INSERT INTO public.chart_of_accounts VALUES(1023,1,true),(1010,1,true);
      INSERT INTO public.accounting_entry_lines VALUES(1,314,1010,100,0),(2,314,1023,0,100);
    `);
  });
  afterAll(async()=>{
    if(!client)return;
    await client.query(`DROP TABLE public.accounting_entry_lines,public.chart_of_accounts,
      public.company_bank_accounts,public.bank_mutations`);
    await client.end();
  });
  const run=()=>assertOutboundSourceBankCoa(client as unknown as OutboundReuseQueryClient,scope);
  it("matches persisted account and credit COA in locked rollback-only transaction",async()=>{
    await client.query("BEGIN");
    try {await expect(run()).resolves.toBe(1023);}
    finally {await client.query("ROLLBACK");}
  });
  it("rejects wrong bank mapping and restores source after rollback",async()=>{
    await client.query("BEGIN");
    try {
      await client.query("UPDATE public.company_bank_accounts SET coa_id=1010 WHERE id=17");
      await expect(run()).rejects.toThrow("PR95_BANK_COA_SOURCE_MISMATCH");
    } finally {await client.query("ROLLBACK");}
    await expect(run()).resolves.toBe(1023);
  });
  it("rejects bank account owned by another company and void mapping",async()=>{
    await client.query("BEGIN");
    try {
      await client.query("UPDATE public.company_bank_accounts SET company_id=2 WHERE id=17");
      await expect(run()).rejects.toThrow("PR95_BANK_COA_UNRESOLVED");
    } finally {await client.query("ROLLBACK");}
    await client.query("BEGIN");
    try {
      await client.query("UPDATE public.company_bank_accounts SET is_active=false WHERE id=17");
      await expect(run()).rejects.toThrow("PR95_BANK_COA_UNRESOLVED");
    } finally {await client.query("ROLLBACK");}
  });
  it("rejects posted credit to wrong bank COA and restores entries",async()=>{
    await client.query("BEGIN");
    try{
      await client.query("UPDATE public.accounting_entry_lines SET account_id=1010 WHERE id=2");
      await expect(run()).rejects.toThrow("PR95_BANK_COA_SOURCE_MISMATCH");
    }finally{await client.query("ROLLBACK");}
    await expect(run()).resolves.toBe(1023);
  });
});
