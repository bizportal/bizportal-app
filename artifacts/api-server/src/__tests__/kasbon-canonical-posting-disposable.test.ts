import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { calculateKasbonAutoDeduction, type KasbonAdvance, type KasbonPlan } from "../routes/payroll-kasbon-automatic";

// Exercise the existing exported canonical finalizer, NOT a second posting
// engine. The journal is a synthetic, pre-existing draft. No actual bank,
// salary transfer, business database or payroll settlement is involved.
const url = process.env.CASH_QA_PG_URL;
const suite = url ? describe : describe.skip;
const actor = { email: "fixture-finance@example.invalid", companyId: 1 };
const plan:KasbonPlan = { advanceId:23, choice:"FULL", installmentAmount:null, firstPeriod:"2026-11-01" };
suite("Canonical kasbon finalization + Payroll preview on disposable PostgreSQL", () => {
  let admin:any, db:any;
  let created=false;
  let post:typeof import("../routes/bank-reconciliation")["postBankMutationCanonical"];
  beforeAll(async()=>{
    const u=new URL(url!);
    if(u.protocol!=="postgresql:"||u.hostname!=="127.0.0.1"||u.port!=="55432"||
       u.pathname!=="/cash_qa"||u.username!=="cash_qa") throw Error("DISPOSABLE_DATABASE_REQUIRED");
    const {Pool}=createRequire(import.meta.url)("pg");
    admin=new Pool({connectionString:url,max:1,connectionTimeoutMillis:3000});
    // New database in the existing disposable CI service. Never drop/reuse an
    // existing database at setup.
    await admin.query("CREATE DATABASE kasbon_lifecycle_qa");
    created=true;
    u.pathname="/kasbon_lifecycle_qa";
    db=new Pool({connectionString:u.toString(),max:4,connectionTimeoutMillis:3000});
    await db.query(`
      CREATE TABLE public.bank_mutations(id integer PRIMARY KEY,status text,journal_entry_id integer,company_id integer,
        direction text,amount numeric,reconciliation_status text,accounting_posted boolean,posted_at timestamptz,
        approved_at timestamptz,review_code text,review_reason text,updated_at timestamptz);
      CREATE TABLE public.accounting_entries(id integer PRIMARY KEY,company_id integer,source text,source_id integer,
        status text,total_debit numeric,total_credit numeric,posted_at timestamptz);
      CREATE TABLE public.accounting_entry_lines(entry_id integer,account_id integer,debit numeric,credit numeric);
      CREATE TABLE public.bank_reconciliation_matches(id integer PRIMARY KEY,mutation_id integer,candidate_type text,
        candidate_id integer,candidate_source text,status text);
      CREATE TABLE public.chart_of_accounts(id integer PRIMARY KEY,company_id integer,code text,is_active boolean,is_postable boolean);
      CREATE TABLE public.cash_advances(id integer PRIMARY KEY,company_id integer,employee_id integer,type text,advance_type text,
        status text,lifecycle_status text,currency text,amount numeric,paid_amount numeric,settled_amount numeric,remaining_amount numeric,
        approved_at timestamptz,approved_by text,disbursed_at timestamptz,disbursed_by text,receivable_account_id integer,
        accounting_entry_id integer,entry_id integer,journal_id integer,posting_status text,voided_at timestamptz,updated_at timestamptz);
      CREATE TABLE public.bank_reconciliation_audit(mutation_id integer,action text,actor text,meta jsonb);
    `);
    post=(await import("../routes/bank-reconciliation")).postBankMutationCanonical;
  });
  afterAll(async()=>{
    try{if(db)await db.end();if(created)await admin.query("DROP DATABASE kasbon_lifecycle_qa");}
    finally{if(admin)await admin.end();}
  });
  beforeEach(async()=>{
    await db.query(`
      TRUNCATE public.bank_mutations,public.accounting_entries,public.accounting_entry_lines,
        public.bank_reconciliation_matches,public.chart_of_accounts,public.cash_advances,public.bank_reconciliation_audit;
      INSERT INTO public.chart_of_accounts VALUES(101,1,'1-1032-CST',true,true),(202,1,'FIXTURE-BANK',true,true);
      INSERT INTO public.cash_advances(id,company_id,employee_id,type,advance_type,status,lifecycle_status,currency,amount,
        paid_amount,settled_amount,remaining_amount,approved_at,approved_by,posting_status)
        VALUES(23,1,21,'kasbon','EMPLOYEE','active','approved','IDR',500000,0,0,500000,now(),'fixture-owner','PENDING');
      INSERT INTO public.bank_mutations(id,status,journal_entry_id,company_id,direction,amount)
        VALUES(31,'approved_pending_posting',901,1,'OUT',500000),(32,'approved_pending_posting',902,1,'OUT',500000);
      INSERT INTO public.accounting_entries(id,company_id,source,source_id,status,total_debit,total_credit)
        VALUES(901,1,'bank_reconciliation',31,'draft',500000,500000),(902,1,'bank_reconciliation',32,'draft',500000,500000);
      INSERT INTO public.accounting_entry_lines VALUES(901,101,500000,0),(901,202,0,500000),(902,101,500000,0),(902,202,0,500000);
      INSERT INTO public.bank_reconciliation_matches VALUES(41,31,'cash_advance',23,'public.cash_advances','approved'),
        (42,32,'cash_advance',23,'public.cash_advances','approved');
    `);
  });
  async function finalize(mutationId=31,who=actor){
    const client=await db.connect();
    try {
      await client.query("BEGIN");
      const result=await post(client,mutationId,mutationId===31?901:902,mutationId===31?41:42,who,{reason:"Synthetic CI only"});
      await client.query("COMMIT");
      return result;
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }
  async function advance():Promise<KasbonAdvance>{
    const r=(await db.query(`SELECT id,company_id AS "companyId",employee_id AS "employeeId",type,status,
      lifecycle_status AS "lifecycleStatus",currency,amount::text,paid_amount::text AS "paidAmount",
      settled_amount::text AS "settledAmount",remaining_amount::text AS "remainingAmount",approved_at::text AS "approvedAt",
      approved_by AS "approvedBy",disbursed_at::text AS "disbursedAt",disbursed_by AS "disbursedBy",
      accounting_entry_id AS "accountingEntryId",posting_status AS "postingStatus",voided_at::text AS "voidedAt"
      FROM public.cash_advances WHERE id=23`)).rows[0];
    return r;
  }
  async function preview(){
    return calculateKasbonAutoDeduction([await advance()],[plan],[],1,21,2026,11);
  }
  async function assertUnposted(mutationId=31){
    const r=(await db.query("SELECT m.status,e.status AS journal_status,m.accounting_posted FROM public.bank_mutations m JOIN public.accounting_entries e ON e.id=m.journal_entry_id WHERE m.id=$1",[mutationId])).rows[0];
    expect(r).toMatchObject({status:"approved_pending_posting",journal_status:"draft",accounting_posted:null});
    expect((await db.query("SELECT count(*)::int n FROM public.bank_reconciliation_audit WHERE mutation_id=$1",[mutationId])).rows[0].n).toBe(0);
  }
  it("approved but not disbursed cannot become a Payroll deduction",async()=>{
    const r=await preview();
    expect(r).toMatchObject({total:null,canApply:false,canSettle:false,canPost:false,canPay:false});
    expect(r.rows[0].issue).toBe("KASBON_PLAN_SOURCE_NOT_ELIGIBLE");
    await assertUnposted();
  });
  it("existing canonical finalizer records real actor, balanced draft, and only a FULL preview",async()=>{
    expect(await finalize()).toMatchObject({status:"posted",journal_entry_id:901,idempotent:false});
    const a=await advance();
    expect(a).toMatchObject({lifecycleStatus:"disbursed",disbursedBy:actor.email,accountingEntryId:901,postingStatus:"POSTED",remainingAmount:"500000"});
    expect(a.disbursedAt).toBeTruthy();
    const lines=(await db.query("SELECT account_id,debit::text,credit::text FROM public.accounting_entry_lines WHERE entry_id=901 ORDER BY account_id")).rows;
    expect(lines).toEqual([{account_id:101,debit:"500000",credit:"0"},{account_id:202,debit:"0",credit:"500000"}]);
    expect((await db.query("SELECT status FROM public.accounting_entries WHERE id=901")).rows[0].status).toBe("posted");
    expect(await preview()).toMatchObject({total:"500000.00",canApply:true,canSettle:false,canPost:false,canPay:false});
    expect((await advance()).remainingAmount).toBe("500000");
  });
  it("replay of the same mutation does not change actor or duplicate the audit",async()=>{
    await finalize();
    const first=await advance();
    expect(await finalize(31,{...actor,email:"fixture-second@example.invalid"})).toMatchObject({idempotent:true,journal_entry_id:901});
    expect(await advance()).toEqual(first);
    expect((await db.query("SELECT count(*)::int n FROM public.bank_reconciliation_audit")).rows[0].n).toBe(1);
  });
  it("a second bank mutation for the same kasbon rolls back journal and mutation changes",async()=>{
    await finalize();
    await expect(finalize(32)).rejects.toMatchObject({code:"CASH_ADVANCE_SOURCE_CHANGED"});
    await assertUnposted(32);
    expect((await advance()).accountingEntryId).toBe(901);
  });
  it("concurrent distinct mutations cannot post the same approved kasbon twice",async()=>{
    const both=await Promise.allSettled([finalize(31),finalize(32)]);
    expect(both.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    expect(both.filter(x=>x.status==="rejected")).toHaveLength(1);
    const counts=(await db.query("SELECT (SELECT count(*)::int FROM public.accounting_entries WHERE status='posted') AS journals,(SELECT count(*)::int FROM public.bank_mutations WHERE status='posted') AS mutations,(SELECT count(*)::int FROM public.bank_reconciliation_audit) AS audits")).rows[0];
    expect(counts).toEqual({journals:1,mutations:1,audits:1});
    expect((await advance()).disbursedBy).toBe(actor.email);
  });
  it.each([
    "UPDATE public.cash_advances SET approved_by=NULL WHERE id=23",
    "UPDATE public.cash_advances SET lifecycle_status='draft' WHERE id=23",
    "UPDATE public.cash_advances SET disbursed_at=now() WHERE id=23",
    "UPDATE public.cash_advances SET journal_id=42 WHERE id=23",
    "UPDATE public.cash_advances SET voided_at=now() WHERE id=23",
    "UPDATE public.cash_advances SET posting_status='POSTED' WHERE id=23",
    "UPDATE public.cash_advances SET company_id=2 WHERE id=23",
    "UPDATE public.bank_mutations SET direction='IN' WHERE id=31",
    "UPDATE public.bank_mutations SET amount=400000 WHERE id=31",
    "UPDATE public.accounting_entry_lines SET account_id=303 WHERE entry_id=901 AND debit>0",
  ])("denies inconsistent source or wrong journal: %s",async sql=>{
    await db.query(sql);
    await expect(finalize()).rejects.toMatchObject({code:"CASH_ADVANCE_SOURCE_CHANGED"});
    await assertUnposted();
    expect((await advance()).accountingEntryId).toBeNull();
  });
  it("rolls back the entire finalization if the final audit insert fails",async()=>{
    await db.query("ALTER TABLE public.bank_reconciliation_audit ADD CONSTRAINT synthetic_failure CHECK (action <> 'CANONICAL_POSTED')");
    try{
      await expect(finalize()).rejects.toThrow();
      await assertUnposted();
      expect(await advance()).toMatchObject({lifecycleStatus:"approved",disbursedAt:null,disbursedBy:null,accountingEntryId:null,postingStatus:"PENDING"});
    }finally{await db.query("ALTER TABLE public.bank_reconciliation_audit DROP CONSTRAINT synthetic_failure");}
  });
  it("does not accept an unbalanced draft or foreign company actor",async()=>{
    await db.query("UPDATE public.accounting_entry_lines SET credit=400000 WHERE entry_id=901 AND credit>0");
    await expect(finalize()).rejects.toMatchObject({code:"UNBALANCED_JOURNAL"});
    await assertUnposted();
    await expect(finalize(31,{...actor,companyId:2})).rejects.toMatchObject({code:"COMPANY_SCOPE_FORBIDDEN"});
    await assertUnposted();
  });
});
