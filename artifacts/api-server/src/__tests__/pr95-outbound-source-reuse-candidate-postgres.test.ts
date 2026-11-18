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
        debit_amount numeric not null,credit_amount numeric not null,
        matching_group_id integer,
        reconciliation_status text,accounting_posted boolean default false,
        approved_at timestamptz,approved_by text,posted_at timestamptz,
        linked_transaction_type text,linked_transaction_id integer,
        review_code text,updated_at timestamptz
      );
      CREATE TABLE public.vendor_invoices(
        id integer primary key,company_id integer,status text,
        cancelled_at timestamptz,grand_total numeric
      );
      CREATE TABLE public.vendor_invoice_lines(
        id integer primary key,invoice_id integer not null
      );
      CREATE TABLE public.vendor_invoice_line_taxes(
        id integer primary key,invoice_line_id integer not null,
        company_id integer not null,tax_amount numeric not null
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
        algorithm_used text,status text CHECK(status IN ('active','reversed','void')),
        created_by text
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
        (id,company_id,direction,status,journal_entry_id,amount,bank_account_id,debit_amount,credit_amount)
        VALUES(90001,1,'OUT','unmatched',NULL,100.00,'17',0,100.00);
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
      public.vendor_invoice_line_taxes,public.vendor_invoice_lines,
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
      (select journal_entry_id from public.bank_mutations where id=90001) journal_id,
      (select matching_group_id from public.bank_mutations where id=90001) linked_group_id`);
    return r.rows[0];
  }
  it("enforces the canonical matching-group status check, not a permissive test-only status",async()=>{
    await client.query("BEGIN");
    try {
      await client.query("SAVEPOINT invalid_group");
      await expect(client.query(
        "INSERT INTO public.payment_matching_groups(company_id,group_type,matching_type,status) VALUES(1,'MULTI_INVOICE','MULTI_INVOICE','final')",
      )).rejects.toMatchObject({code:"23514"});
      await client.query("ROLLBACK TO SAVEPOINT invalid_group");
      await expect(client.query(
        "INSERT INTO public.payment_matching_groups(company_id,group_type,matching_type,status) VALUES(1,'MULTI_INVOICE','MULTI_INVOICE','active') RETURNING id",
      )).resolves.toMatchObject({rowCount:1});
    }finally{
      await client.query("ROLLBACK");
    }
  });
  it("reuses posted source journal atomically without any second accounting entry",async()=>{
    await client.query("BEGIN");
    try{
      const result=await execute();
      expect(result).toMatchObject({mutationId:90001,invoiceId:7,sourceEntryId:314});
      expect(await counts()).toMatchObject({
        journals:1,allocations:1,matches:1,audits:1,mutation_status:"posted",journal_id:314,
        linked_group_id:expect.any(Number),
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
  it("rejects fractional-cent invoice totals without rounding",async()=>{
    await client.query("BEGIN");
    try{
      await client.query("update public.vendor_invoices set grand_total=100.001 where id=7");
      await expect(execute()).rejects.toThrow("PR95_SOURCE_REUSE_PARTIAL_OR_TAX_UNSUPPORTED");
    }finally{await client.query("ROLLBACK");}
    expect(await counts()).toMatchObject({journals:1,allocations:0,matches:0,audits:0});
  });
  it("blocks a second real OUT mutation from reusing the same finalized invoice source",async()=>{
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO public.bank_mutations
         (id,company_id,direction,status,journal_entry_id,amount,bank_account_id,debit_amount,credit_amount)
         VALUES(90002,1,'OUT','unmatched',NULL,100.00,'17',0,100.00)`);
      await execute();
      await expect(finalizeOutboundSourceReuseCandidate(
        client as unknown as OutboundReuseQueryClient,
        {...input,mutationId:90002}
      )).rejects.toThrow("PR95_OUTBOUND_FINALIZED_CUSTODY_EXISTS");
      expect(await counts()).toMatchObject({
        journals:1,allocations:1,matches:1,audits:1,
      });
    }finally{await client.query("ROLLBACK");}
    expect(await counts()).toMatchObject({
      journals:1,allocations:0,matches:0,audits:0,mutation_status:"unmatched",
    });
    const absent=await client.query("select count(*)::int as n from public.bank_mutations where id=90002");
    expect(absent.rows[0].n).toBe(0);
  });
  it("serializes two actual PostgreSQL sessions attempting different mutations for one invoice",async()=>{
    const second=new pg.Client({connectionString:url});
    await second.connect();
    let firstCommitted=false;
    try {
      await client.query(`INSERT INTO public.bank_mutations
        (id,company_id,direction,status,journal_entry_id,amount,bank_account_id,debit_amount,credit_amount)
        VALUES(90002,1,'OUT','unmatched',NULL,100.00,'17',0,100.00)`);
      await client.query("BEGIN");
      await execute();
      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout='8s'");
      const conflictingLock=await second.query(
        "select pg_try_advisory_xact_lock(hashtextextended($1::text,0)) as acquired",
        ["pr95:vendor-invoice:1:7"],
      );
      expect(conflictingLock.rows[0].acquired).toBe(false);
      // Second session must wait on invoice lock held by first transaction;
      // after first COMMIT its canonical allocation is visible and rejected.
      const racing=finalizeOutboundSourceReuseCandidate(
        second as unknown as OutboundReuseQueryClient,
        {...input,mutationId:90002}
      ).then(()=>({ok:true,error:""}),(e:unknown)=>({ok:false,error:String(e)}));
      await client.query("COMMIT");
      firstCommitted=true;
      const raced=await racing;
      expect(raced.ok).toBe(false);
      expect(raced.error).toContain("PR95_OUTBOUND_FINALIZED_CUSTODY_EXISTS");
      await second.query("ROLLBACK");
      const result=await counts();
      expect(result).toMatchObject({
        journals:1,allocations:1,matches:1,audits:1,mutation_status:"posted",journal_id:314,
      });
    }finally{
      await second.query("ROLLBACK").catch(()=>{});
      await second.end();
      if(!firstCommitted) await client.query("ROLLBACK").catch(()=>{});
      // Cleanup is ONLY against disposable PostgreSQL and leaves test
      // baseline unchanged for subsequent scenarios.
      await client.query("BEGIN");
      try {
        await client.query("DELETE FROM public.bank_reconciliation_audit");
        await client.query("DELETE FROM public.bank_reconciliation_matches");
        await client.query("DELETE FROM public.payment_allocations");
        await client.query("DELETE FROM public.payment_matching_groups");
        await client.query("UPDATE public.bank_mutations SET status='unmatched',journal_entry_id=NULL,reconciliation_status=NULL,accounting_posted=false,approved_at=NULL,approved_by=NULL,posted_at=NULL,linked_transaction_type=NULL,linked_transaction_id=NULL,review_code=NULL WHERE id=90001");
        await client.query("DELETE FROM public.bank_mutations WHERE id=90002");
        await client.query("COMMIT");
      }catch(err){await client.query("ROLLBACK");throw err;}
    }
    expect(await counts()).toMatchObject({
      journals:1,allocations:0,matches:0,audits:0,mutation_status:"unmatched",journal_id:null,
    });
  });
  it("rejects sub-cent liability debit even if floating-point rounding looks balanced",async()=>{
    await client.query("BEGIN");
    try{
      await client.query("UPDATE public.accounting_entry_lines SET debit=100.001 WHERE id=1");
      await expect(execute()).rejects.toThrow("PR95_OUTBOUND_AMOUNT_INVALID");
    }finally{await client.query("ROLLBACK");}
    const r=await client.query("SELECT debit::text AS amount FROM public.accounting_entry_lines WHERE id=1");
    expect(Number(r.rows[0].amount)).toBe(100);
  });
  it("rejects nonzero canonical invoice tax lines before writing allocations",async()=>{
    await client.query("BEGIN");
    try{
      await client.query("INSERT INTO public.vendor_invoice_lines VALUES(88,7)");
      await client.query("INSERT INTO public.vendor_invoice_line_taxes VALUES(99,88,1,10.00)");
      await expect(execute()).rejects.toThrow("PR95_SOURCE_REUSE_TAX_LINES_UNSUPPORTED");
    }finally{await client.query("ROLLBACK");}
    expect(await counts()).toMatchObject({journals:1,allocations:0,matches:0,audits:0});
  });
  it("blocks an existing active allocation even when its mutation is not posted",async()=>{
    await client.query("BEGIN");
    try{
      const group=await client.query(
        `INSERT INTO public.payment_matching_groups
          (company_id,group_type,matching_type,total_mutation_amount,total_invoice_amount,
           total_allocated,remaining_amount,confidence,algorithm_used,status,created_by)
         VALUES(1,'MULTI_INVOICE','MULTI_INVOICE',100,100,100,0,100,'old_pending','active','test')
         RETURNING id`,
      );
      await client.query(
        `INSERT INTO public.payment_allocations
          (group_id,company_id,invoice_id,mutation_id,allocated_amount,remaining_amount,
           allocation_sequence,strategy,is_active)
         VALUES($1,1,7,90001,100,0,1,'MANUAL',true)`,
        [group.rows[0].id],
      );
      await expect(execute()).rejects.toThrow("PR95_OUTBOUND_FINALIZED_CUSTODY_EXISTS");
    }finally{await client.query("ROLLBACK");}
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
