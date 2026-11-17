import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import express from "express";
import { createServer,type Server } from "node:http";
import { once } from "node:events";
import pg from "pg";
import type { OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

// Only substitute @workspace/db connection routing with disposable PG.
// Real signed-cookie validation, DB user lookup, locks and finance writer run.
const shared=vi.hoisted(()=>({authClient:null as null | pg.Client}));
vi.mock("@workspace/db",()=>({
  pool:{query:async(sql:string,args?:unknown[])=>{
    if(!shared.authClient) throw Error("PR95_HTTP_PG_UNAVAILABLE");
    return shared.authClient.query(sql,args);
  }},
  getRuntimeDatabaseUrl:async()=>{throw Error("PR95_NO_EXTERNAL_DB");},
}));
import { setProductionSessionCookie } from "../routes/dev-auth";
import { runOutboundReuseSignedDevCandidate } from "../lib/outboundSourceReuseDevBridge";

const url=process.env.PR95_ATOMIC_PG_URL;
const suite=url?describe:describe.skip;
const input={companyId:1,mutationId:90001,invoiceId:7};
suite("PR95 signed Super Admin + real source reuse writer via isolated HTTP",()=>{
  let auth:pg.Client;
  let server:Server;
  let origin="";
  let cookie="";
  const previous={
    app:process.env.APP_ENV,secret:process.env.BIZPORTAL_SESSION_SECRET,
    otp:process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV,
    feature:process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV,
  };
  const issueCookie=()=>{
    const issued=Date.now();
    const headers:string[]=[];
    setProductionSessionCookie({
      append:(name:string,value:string)=>{
        if(name==="Set-Cookie")headers.push(value);
      },
    } as never,{
      id:"pr95-ci-superadmin",email:"owner@pr95.invalid",
      issuedAt:issued,expiresAt:issued+60000,
    });
    return (headers[0]??"").split(";")[0]??"";
  };
  const send=async(payload:unknown=input,session=cookie)=>{
    const res=await fetch(origin+"/__isolated__/vendor-out-reuse",{
      method:"POST",headers:{"content-type":"application/json",...(session?{cookie:session}:{})},
      body:JSON.stringify(payload),
    });
    return {status:res.status,body:await res.json() as Record<string,unknown>};
  };
  const counters=async()=>{
    const q=await auth.query(`SELECT
      (SELECT count(*)::int FROM public.accounting_entries) journals,
      (SELECT count(*)::int FROM public.payment_allocations) allocations,
      (SELECT count(*)::int FROM public.bank_reconciliation_matches) matches,
      (SELECT count(*)::int FROM public.bank_reconciliation_audit) audits,
      (SELECT status FROM public.bank_mutations WHERE id=90001) mutation_status`);
    return q.rows[0];
  };
  beforeAll(async()=>{
    const parsed=new URL(url!);
    if(parsed.hostname!=="127.0.0.1"||parsed.port!=="65433"
      ||parsed.pathname!=="/pr95_ci"
      ||parsed.username!=="postgres.xssrfshdrtdfupgqwfdw")
      throw Error("PR95_REFUSE_NON_DISPOSABLE_HTTP_DB");
    process.env.APP_ENV="development";
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV="true";
    process.env.BIZPORTAL_SESSION_SECRET="pr95-isolated-only-test-key-not-real-0000001";
    process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV="true";
    auth=new pg.Client({connectionString:url});
    await auth.connect();
    shared.authClient=auth;
    await auth.query(`
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
        (id,company_id,direction,status,journal_entry_id,amount,bank_account_id)
        VALUES(90001,1,'OUT','unmatched',NULL,100.00,'17');
      INSERT INTO public.vendor_invoices VALUES(7,1,'posted',NULL,100.00);
      INSERT INTO public.bank_disbursements VALUES(2,1,314,'posted',NULL);
      INSERT INTO public.bank_disbursement_items VALUES(1,2,7,100.00);
      INSERT INTO public.accounting_entries VALUES(314,1,'manual_payment','posted',NULL,NULL,100.00,100.00);
      INSERT INTO public.accounting_entry_lines VALUES(1,314,1010,100.00,0),(2,314,1023,0,100.00);
      INSERT INTO public.company_bank_accounts VALUES(17,1,1023,true);
      INSERT INTO public.chart_of_accounts VALUES(1010,1,true,'2-1010-CST'),(1023,1,true,'1-1023-CST');

      CREATE TABLE public.users(id text primary key,email text,role text,
        company_id integer,is_active boolean,status text);
      INSERT INTO public.users VALUES
        ('pr95-ci-superadmin','owner@pr95.invalid','super_admin',1,true,'active');
    `);
    const app=express();
    app.use(express.json({limit:"4kb"}));
    // Test ONLY. No registration in production/API routers.
    app.post("/__isolated__/vendor-out-reuse",async(req,res)=>{
      const body=req.body as Record<string,unknown>;
      if(!body || !["companyId","mutationId","invoiceId"].every(k=>
        Number.isSafeInteger(body[k]) && Number(body[k])>0)
        || Object.keys(body).length!==3){
        res.status(422).json({error:"INVALID_INPUT"});return;
      }
      const conn=new pg.Client({connectionString:url});
      await conn.connect();
      try{
        await conn.query("BEGIN");
        const receipt=await runOutboundReuseSignedDevCandidate(
          req,conn as unknown as OutboundReuseQueryClient,
          {companyId:Number(body.companyId),mutationId:Number(body.mutationId),invoiceId:Number(body.invoiceId)},
        );
        await conn.query("COMMIT");
        res.status(200).json({ok:true,receipt});
      }catch(err){
        await conn.query("ROLLBACK").catch(()=>{});
        res.status(409).json({ok:false,reason:err instanceof Error?err.message:"rejected"});
      }finally{await conn.end();}
    });
    server=createServer(app);
    server.listen(0,"127.0.0.1");
    await once(server,"listening");
    const address=server.address();
    if(!address||typeof address==="string")throw Error("NO_LOCAL_HTTP");
    origin="http://127.0.0.1:"+address.port;
    cookie=issueCookie();
  });
  beforeEach(async()=>{
    process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV="true";
    await auth.query(`
      TRUNCATE public.bank_reconciliation_audit,public.bank_reconciliation_matches,
        public.payment_allocations,public.payment_matching_groups RESTART IDENTITY;
      UPDATE public.bank_mutations SET status='unmatched',journal_entry_id=NULL,
        reconciliation_status=NULL,accounting_posted=false,
        approved_at=NULL,approved_by=NULL,posted_at=NULL,
        linked_transaction_type=NULL,linked_transaction_id=NULL,review_code=NULL
        WHERE id=90001;
      UPDATE public.users SET role='super_admin',is_active=true,status='active'
        WHERE id='pr95-ci-superadmin';
    `);
  });
  afterAll(async()=>{
    if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(auth){
      await auth.query(`
        DROP TABLE public.users,public.bank_reconciliation_audit,
          public.bank_reconciliation_matches,public.payment_allocations,
          public.payment_matching_groups,public.chart_of_accounts,
          public.company_bank_accounts,public.accounting_entry_lines,
          public.accounting_entries,public.bank_disbursement_items,
          public.bank_disbursements,public.vendor_invoices,public.bank_mutations;
      `);
      await auth.end();
    }
    shared.authClient=null;
    for(const [k,v] of Object.entries({
      APP_ENV:previous.app,BIZPORTAL_SESSION_SECRET:previous.secret,
      BIZPORTAL_SIGNED_OTP_ENABLED_DEV:previous.otp,
      PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV:previous.feature,
    })){if(v===undefined) delete process.env[k];else process.env[k]=v;}
  });
  it("authenticates signed super_admin and executes real writer with one source journal",async()=>{
    const reply=await send();
    expect(reply.status).toBe(200);
    expect(reply.body.ok).toBe(true);
    expect(reply.body.receipt).toMatchObject({mutationId:90001,invoiceId:7,sourceEntryId:314});
    expect(await counters()).toMatchObject({
      journals:1,allocations:1,matches:1,audits:1,mutation_status:"posted",
    });
    const replay=await send();
    expect(replay.status).toBe(409);
    expect(await counters()).toMatchObject({journals:1,allocations:1,matches:1,audits:1});
  });
  it("rejects missing/tampered cookie, wrong company and downgraded role before writes",async()=>{
    expect((await send(input,"")).status).toBe(409);
    const tampered=cookie.slice(0,-1)+(cookie.endsWith("A")?"B":"A");
    expect((await send(input,tampered)).status).toBe(409);
    expect((await send({...input,companyId:2})).status).toBe(409);
    await auth.query("UPDATE public.users SET role='finance' WHERE id='pr95-ci-superadmin'");
    expect((await send()).status).toBe(409);
    expect(await counters()).toMatchObject({journals:1,allocations:0,matches:0,audits:0});
  });
  it("rejects inactive user, disabled bridge and incorrect invoice without financial rows",async()=>{
    await auth.query("UPDATE public.users SET is_active=false WHERE id='pr95-ci-superadmin'");
    expect((await send()).status).toBe(409);
    await auth.query("UPDATE public.users SET is_active=true WHERE id='pr95-ci-superadmin'");
    delete process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV;
    expect((await send()).status).toBe(409);
    process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV="true";
    expect((await send({...input,invoiceId:8})).status).toBe(409);
    expect(await counters()).toMatchObject({journals:1,allocations:0,matches:0,audits:0});
  });
  it("rolls back the real HTTP transaction when mutation posting fails after allocation writes",async()=>{
    await auth.query(`CREATE FUNCTION public.pr95_http_fail_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $pr95_http$
        BEGIN IF NEW.status='posted' THEN
          RAISE EXCEPTION 'PR95_HTTP_INJECTED_FAILURE';
        END IF;
        RETURN NEW;
      END $pr95_http$`);
    await auth.query(`CREATE TRIGGER pr95_http_fail_mutation
      BEFORE UPDATE ON public.bank_mutations
      FOR EACH ROW EXECUTE FUNCTION public.pr95_http_fail_mutation()`);
    try {
      const result=await send();
      expect(result.status).toBe(409);
      expect(result.body.reason).toContain("PR95_HTTP_INJECTED_FAILURE");
      expect(await counters()).toMatchObject({
        journals:1,allocations:0,matches:0,audits:0,mutation_status:"unmatched",
      });
    } finally {
      await auth.query("DROP TRIGGER IF EXISTS pr95_http_fail_mutation ON public.bank_mutations");
      await auth.query("DROP FUNCTION IF EXISTS public.pr95_http_fail_mutation()");
    }
  });
  it("shows finalized canonical allocation without a second journal after successful HTTP payment",async()=>{
    expect((await send()).status).toBe(200);
    const result=await auth.query(`select
      coalesce(sum(pa.allocated_amount),0)::numeric as canonical_paid
      from public.payment_allocations pa
      join public.payment_matching_groups pmg on pmg.id=pa.group_id
      join public.bank_mutations bm on bm.id=pa.mutation_id
      where pa.company_id=1 and pa.invoice_id=7 and pa.is_active=true
        and pmg.status='active' and bm.status='posted'`);
    expect(Number(result.rows[0].canonical_paid)).toBe(100);
    const journal=await auth.query("select count(*)::int as n from public.accounting_entries");
    expect(journal.rows[0].n).toBe(1);
  });
  it("rejects simultaneous HTTP requests for same source with one allocation only",async()=>{
    const responses=await Promise.all([send(),send()]);
    expect(responses.map(x=>x.status).sort()).toEqual([200,409]);
    expect(await counters()).toMatchObject({
      journals:1,allocations:1,matches:1,audits:1,mutation_status:"posted",
    });
  });
});
