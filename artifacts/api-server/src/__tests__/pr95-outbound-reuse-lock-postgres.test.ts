import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { lockOutboundSourceJournalReuseScope } from "../lib/outboundReuseTransactionScope";
import type { OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

const url=process.env.PR95_ATOMIC_PG_URL;
const suite=url?describe:describe.skip;
const scope={companyId:1,mutationId:90001,invoiceId:7};

suite("PR95 locked outbound source journal preflight on disposable PostgreSQL 16",()=>{
  let client:pg.Client;
  beforeAll(async()=>{
    const parsed=new URL(url!);
    if(parsed.hostname!=="127.0.0.1"||parsed.port!=="65433"||parsed.pathname!=="/pr95_ci"
      ||parsed.username!=="postgres.xssrfshdrtdfupgqwfdw") throw Error("PR95_NON_DISPOSABLE_DB_REFUSED");
    client=new pg.Client({connectionString:url});
    await client.connect();
    await client.query(`
      CREATE TABLE public.bank_mutations
        (id integer primary key, company_id integer not null, direction text not null,
         status text not null, journal_entry_id integer);
      CREATE TABLE public.vendor_invoices
        (id integer primary key, company_id integer not null,status text not null,cancelled_at timestamptz);
      CREATE TABLE public.bank_disbursements
        (id integer primary key,company_id integer not null,entry_id integer,
         status text not null,void_entry_id integer);
      CREATE TABLE public.bank_disbursement_items
        (id integer primary key,disbursement_id integer not null,vendor_invoice_id integer);
      CREATE TABLE public.accounting_entries
        (id integer primary key,company_id integer not null,source text not null,
         status text not null,cancelled_at timestamptz,voided_at timestamptz);
      CREATE TABLE public.bank_reconciliation_matches
        (id integer primary key,mutation_id integer,status text not null);
      CREATE TABLE public.payment_matching_groups
        (id integer primary key,status text not null);
      CREATE TABLE public.payment_allocations
        (id integer primary key,company_id integer not null,invoice_id integer not null,
         group_id integer,mutation_id integer not null,is_active boolean);
      INSERT INTO public.bank_mutations VALUES(90001,1,'OUT','unmatched',NULL);
      INSERT INTO public.vendor_invoices VALUES(7,1,'posted',NULL);
      INSERT INTO public.bank_disbursements VALUES(2,1,314,'posted',NULL);
      INSERT INTO public.bank_disbursement_items VALUES(1,2,7);
      INSERT INTO public.accounting_entries VALUES(314,1,'manual_payment','posted',NULL,NULL);
      INSERT INTO public.payment_matching_groups VALUES(5,'active');
    `);
  });
  afterAll(async()=>{
    if(!client)return;
    await client.query(`DROP TABLE public.payment_allocations,public.payment_matching_groups,
      public.bank_reconciliation_matches,public.accounting_entries,
      public.bank_disbursement_items,public.bank_disbursements,
      public.vendor_invoices,public.bank_mutations;`);
    await client.end();
  });
  const lock=()=>lockOutboundSourceJournalReuseScope(client as unknown as OutboundReuseQueryClient,scope);
  it("locks actual scoped rows and obtains zero-finality outcome, then rolls back",async()=>{
    await client.query("BEGIN");
    try{
      await expect(lock()).resolves.toEqual({
        mutationId:90001,invoiceId:7,disbursementId:2,sourceEntryId:314,
        finality:{mutationFinalMatchCount:0,sourceFinalAllocationCount:0,activeApprovedMutationLinkCount:0},
      });
    }finally{await client.query("ROLLBACK");}
    const readback=await client.query("select journal_entry_id from public.bank_mutations where id=90001");
    expect(readback.rows[0].journal_entry_id).toBeNull();
  });
  it("rejects replay custody in same transaction and preserves original rows after rollback",async()=>{
    await client.query("BEGIN");
    try{
      await client.query(`
        insert into public.bank_reconciliation_matches values(3,90001,'approved');
        insert into public.payment_allocations values(4,1,7,5,90001,true);
        update public.payment_matching_groups set status='final' where id=5;
      `);
      await expect(lock()).rejects.toThrow("PR95_OUTBOUND_FINALIZED_CUSTODY_EXISTS");
    }finally{await client.query("ROLLBACK");}
    const recheck=await client.query("select count(*)::int as n from public.bank_reconciliation_matches");
    expect(recheck.rows[0].n).toBe(0);
  });
  it("rejects bank direction mismatch and voided source journal atomically",async()=>{
    await client.query("BEGIN");
    try{
      await client.query("update public.bank_mutations set direction='IN' where id=90001");
      await expect(lock()).rejects.toThrow("PR95_OUTBOUND_MUTATION_NOT_ELIGIBLE");
    }finally{await client.query("ROLLBACK");}
    await client.query("BEGIN");
    try{
      await client.query("update public.accounting_entries set voided_at=now() where id=314");
      await expect(lock()).rejects.toThrow("PR95_OUTBOUND_SOURCE_JOURNAL_INVALID");
    }finally{await client.query("ROLLBACK");}
  });
});
