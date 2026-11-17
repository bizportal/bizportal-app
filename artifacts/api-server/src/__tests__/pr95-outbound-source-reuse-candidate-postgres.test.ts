import { afterAll,beforeAll,describe,expect,it } from "vitest";
import pg from "pg";
import { finalizeOutboundSourceReuseCandidate } from "../lib/outboundSourceReuseCandidate";
import type { OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

const url=process.env.PR95_ATOMIC_PG_URL;
const suite=url?describe:describe.skip;
const input={companyId:1,mutationId:90001,invoiceId:7,verifiedActorEmail:"isolated@pr95.invalid"};
suite("PR95 unregistered source-owned OUT reuse transition on disposable PostgreSQL",()=>{
  let client:pg.Client;
  beforeAll(async()=>{
    const u=new URL(url!);
    if(u.hostname!=="127.0.0.1"||u.port!=="65433"||u.pathname!=="/pr95_ci"
      ||u.username!=="postgres.xssrfshdrtdfupgqwfdw")throw Error("PR95_NON_DISPOSABLE_REFUSED");
    client=new pg.Client({connectionString:url});
    await client.connect();
    await client.query(`
      CREATE TABLE public.bank_mutations(
        id integer primary key,company_id integer,direction text,status text,
        journal_entry_id integer,amount numeric,bank_account_id text,
        reconciliation_status text,accounting_posted boolean default false,
        approved_at timestamptz,approved_by text,posted_at timestamptz,
        linked_transaction_type text,linked_transaction_id integer,
        review_code text,updated_at timestamptz
      );
      CREATE TABLE public.vendor_invoices(
        id integer primary key,company_id integer,status text,
        cancelled_at timestamptz,grand_total numeric
      );
      CREATE TABLE public.bank_disbursements(
        id integer primary key,company_id integer,entry_id integer,
        status text,void_entry_id integer
      );
      CREATE TABLE public.bank_disbursement_items(
        id integer primary key,disbursement_id integer,
        vendor_invoice_id integer,amount numeric
      );
      CREATE TABLE public.accounting_entries(
        id integer primary key,company_id integer,source text,status text,
        cancelled_at timestamptz,voided_at timestamptz,
        total_debit numeric,total_credit numeric
      );
      CREATE TABLE public.accounting_entry_lines(
        id integer primary key,entry_id integer,account_id integer,
        debit numeric,credit numeric
      );
      CREATE TABLE public.company_bank_accounts(
        id integer primary key,company_id integer,coa_id integer,is_active boolean
      );
      CREATE TABLE public.chart_of_accounts(
        id integer primary key,company_id integer,is_active boolean,code text
      );
      CREATE TABLE public.payment_matching_groups(
        id serial primary key,company_id integer,group_type text,matching_type text,
        total_mutation_amount numeric,total_invoice_amount numeric,
        total_allocated numeric,remaining_amount numeric,confidence integer,
        algorithm_used text,status text,created_by text
      );
      CREATE TABLE public.payment_allocations(
        id serial primary key,group_id integer,company_id integer,
        invoice_id integer,mutation_id integer,allocated_amount numeric,
        remaining_amount numeric,allocation_sequence integer,strategy text,
        is_active boolean
      );
      CREATE TABLE public.bank_reconciliation_matches(
        id serial primary key,mutation_id integer,candidate_type text,
        candidate_id text,match_score integer,match_reason text,amount_match boolean,
        date_match boolean,name_match boolean,order_id_match boolean,proof_match boolean,
        status text,candidate_source text,is_manual boolean
      );
      CREATE TABLE public.bank_reconciliation_audit(
        id serial primary key,mutation_id integer,action text,actor text,meta jsonb
      );
      INSERT INTO public.bank_mutations
        (id,company_id,direction,status,journal_entry_id,amount,bank_account_id)
        VALUES(90001,1,'OUT','unmatched',NULL,100.00,'17');
      INSERT INTO public.vendor_invoices VALUES(7,1,'posted',NULL,100.00);
      INSERT INTO public.bank_disbursements VALUES(2,1,314,'posted',NULL);
      INSERT INTO public.bank_disbursement_items VALUES(1,2,7,100.00);
      INSERT INTO public.accounting_entries VALUES(314,1,'manual_payment','posted',NULL,NULL,100.00,100.00);
      INSERT INTO public.accounting_entry_lines VALUES(1,314,1010,100.00,0),(2,314,1023,0,100.00);
      INSERT INTO public.company_bank_accounts VALUES(17,1,1023,true);
      INSERT INTO public.chart_of_accounts VALUES(1010,1,true,'2-1010-CST'),(1023,1,true,'1-1023-CST');
    `);
  });
  afterAll(async()=>{
    if(!client)return;
    await client.query(`DROP TABLE public.bank_reconciliation_audit,public.bank_reconciliation_matches,
      public.payment_allocations,public.payment_matching_groups,public.chart_of_accounts,
      public.company_bank_accounts,public.accounting_entry_lines,public.accounting_entries,
      public.bank_disbursement_items,public.bank_disbursements,
      public.vendor_invoices,public.bank_mutations`);
    await client.end();
  });
  const execute=()=>finalizeOutboundSourceReuseCandidate(client as unknown as OutboundReuseQueryClient,input);
  async function counts(){
    const r=await client.query(`SELECT
      (select count(*)::int from public.accounting_entries) journals,
      (select count(*)::int from public.payment_allocations) allocations,
      (select count(*)::int from public.bank_reconciliation_matches) matches,
      (select count(*)::int from public.bank_reconciliation_audit) audits,
      (select status from public.bank_mutations where id=90001) mutation_status,
      (select journal_entry_id from public.bank_mutations where id=90001) journal_id`);
    return r.rows[0];
  }
  it("reuses posted source journal atomically without any second accounting entry",async()=>{
    await client.query("BEGIN");
    try{
      const result=await execute();
      expect(result).toMatchObject({mutationId:90001,invoiceId:7,sourceEntryId:314});
      expect(await counts()).toMatchObject({
        journals:1,allocations:1,matches:1,audits:1,mutation_status:"posted",journal_id:314,
      });
      await expect(execute()).rejects.toThrow("PR95_OUTBOUND_MUTATION_NOT_ELIGIBLE");
    }finally{await client.query("ROLLBACK");}
    expect(await counts()).toMatchObject({
      journals:1,allocations:0,matches:0,audits:0,mutation_status:"unmatched",journal_id:null,
    });
  });
  it("rejects partial settlement, malformed principal, and unsupported bank/source amount",async()=>{
    await client.query("BEGIN");
    try{
      await client.query("update public.vendor_invoices set grand_total=120.00 where id=7");
      await expect(execute()).rejects.toThrow("PR95_SOURCE_REUSE_PARTIAL_OR_TAX_UNSUPPORTED");
    }finally{await client.query("ROLLBACK");}
    await expect(finalizeOutboundSourceReuseCandidate(client as unknown as OutboundReuseQueryClient,
      {...input,verifiedActorEmail:"not-authorized"})).rejects.toThrow("PR95_SOURCE_REUSE_INVALID_ACTOR_SCOPE");
    expect(await counts()).toMatchObject({journals:1,allocations:0,matches:0,audits:0});
  });
  it("rejects invalid AP debit account before financial writes",async()=>{
    await client.query("BEGIN");
    try{
      await client.query("update public.chart_of_accounts set code='5-9999-CST' where id=1010");
      await expect(execute()).rejects.toThrow("PR95_SOURCE_REUSE_AP_CUSTODY_INVALID");
    }finally{await client.query("ROLLBACK");}
    expect(await counts()).toMatchObject({journals:1,allocations:0,matches:0,audits:0});
  });
  it("rolls back all accounting-link writes after mutation update fails",async()=>{
    await client.query("BEGIN");
    try{
      await client.query(`CREATE OR REPLACE FUNCTION public.pr95_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status='posted' THEN RAISE EXCEPTION 'INJECTED_MUTATION_FAILURE'; END IF;
          RETURN NEW; END $$`);
      await client.query(`CREATE TRIGGER pr95_mutation_failure BEFORE UPDATE ON public.bank_mutations
        FOR EACH ROW EXECUTE FUNCTION public.pr95_reject_mutation()`);
      await expect(execute()).rejects.toThrow("INJECTED_MUTATION_FAILURE");
    }finally{await client.query("ROLLBACK");}
    expect(await counts()).toMatchObject({journals:1,allocations:0,matches:0,audits:0,mutation_status:"unmatched"});
  });
});
