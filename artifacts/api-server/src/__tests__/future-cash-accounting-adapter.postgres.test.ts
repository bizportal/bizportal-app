import { describe,it,expect,beforeAll,afterAll } from "vitest";
import { createRequire } from "node:module";
import { postApprovedFutureCashWithinTransaction,type FutureCashAccountingClient,type FutureCashAccountingEvidence } from "../lib/future-cash-accounting-adapter";
import { prepareFutureCashSource } from "../lib/future-cash-source-identity";

const url=process.env.CASH_QA_PG_URL;
const suite=url?describe:describe.skip;
suite("Account18 accounting adapter on isolated PostgreSQL",()=>{
  let pool:any;
  const uuid=(n:number)=>"aaaaaaaa-aaaa-4aaa-8aaa-"+String(n).padStart(12,"0");
  function evidence(id:string,direction:"IN"|"OUT"="IN",contra=902):FutureCashAccountingEvidence {
    const source={companyId:1,accountId:18,cashCoaId:75839,transactionId:id,sourceDocumentSha256:"a".repeat(64),date:"2026-11-27",direction,amount:"10000.00"};
    return {source,receipt:{transactionId:id,companyId:1,accountId:18,sha256:source.sourceDocumentSha256,status:"VERIFIED",verifiedAt:"2026-11-27T00:00:00.000Z"},approval:{transactionId:id,companyId:1,accountId:18,sourceFingerprint:prepareFutureCashSource(source).sourceFingerprint,counterCoaId:contra,status:"APPROVED",authenticationMethod:"SIGNED_EMAIL_OTP",authorizedRole:"owner",approvedAt:"2026-11-27T00:01:00.000Z"},coa:{id:contra,companyId:1,isActive:true,isPostable:true,isHeader:false},approverEmail:"owner@example.test"};
  }
  beforeAll(async()=>{
    // Hard refuse any remote/business database; these fixtures create public tables
    // because the staged adapter deliberately uses explicit schema qualification.
    const u=new URL(url!);
    if(u.hostname!=="127.0.0.1"||u.port!=="55432"||u.pathname!=="/cash_qa"||u.username!=="cash_qa")throw Error("DISPOSABLE_DATABASE_REQUIRED");
    const {Pool}=createRequire(import.meta.url)("pg");
    pool=new Pool({connectionString:url,max:4});
    await pool.query(`
      create table public.accounting_journals(id serial primary key,company_id int,type text,is_active bool,code text,default_debit_account_id int,default_credit_account_id int);
      insert into public.accounting_journals(company_id,type,is_active,code,default_debit_account_id,default_credit_account_id) values(1,'cash',true,'CSH-SC-CST',75839,75839),(1,'cash',true,'CSH-CST',49097,49097);
      create table public.accounting_entries(id serial primary key,company_id int not null,entry_number text unique not null,journal_id int references accounting_journals(id),date date,ref text,description text,status text,source text,total_debit numeric(16,2),total_credit numeric(16,2),created_by_id text,approved_by text,approved_at timestamptz,ledger_source_type text,ledger_source_id text,checksum_hash text,correlation_id text,source_schema text,source_module text,source_table text,entry_status text,posted_at timestamp,check(total_debit=total_credit));
      create table public.accounting_entry_lines(id serial primary key,entry_id int references accounting_entries(id),account_id int,company_id int,debit numeric(16,2),credit numeric(16,2),description text,source_module text,source_table text,check((debit>0 and credit=0) or (credit>0 and debit=0)));
      create table public.fleet_ledger_entries(company_id int,source_ref text,account_id int,debit numeric(16,2),credit numeric(16,2));
      create function public.qa_cash_sync() returns trigger language plpgsql as $$begin
        if (select status from accounting_entries where id=new.entry_id)<>'draft' then raise exception 'IMMUTABLE'; end if;
        if new.account_id=997 then raise exception 'QA_LINE_FAILURE'; end if;
        if new.account_id<>998 then
          insert into fleet_ledger_entries select new.company_id,entry_number,new.account_id,new.debit,new.credit from accounting_entries where id=new.entry_id;
        end if;
        return new;
      end$$;
      create trigger qa_cash_sync after insert on accounting_entry_lines for each row execute function qa_cash_sync();
    `);
  });
  afterAll(async()=>{if(pool)await pool.end();});
  async function post(e:FutureCashAccountingEvidence){
    const c=await pool.connect();
    try{await c.query("BEGIN");const result=await postApprovedFutureCashWithinTransaction(c as FutureCashAccountingClient,e.source.transactionId,async()=>e);await c.query("COMMIT");return result;}
    catch(err){await c.query("ROLLBACK");throw err;}finally{c.release();}
  }
  async function counts(id:string){
    const ref="SC-CASH-"+id;
    return (await pool.query("select (select count(*)::int from accounting_entries where ref=$1) headers,(select count(*)::int from accounting_entry_lines where entry_id in(select id from accounting_entries where ref=$1)) lines,(select count(*)::int from fleet_ledger_entries where source_ref=$1) ledger",[ref])).rows[0];
  }
  it("posts IN and OUT with exact balanced ledger and dedicated mapping",async()=>{
    for(const [n,dir] of [[1,"IN"],[2,"OUT"]] as const){
      const e=evidence(uuid(n),dir);const r=await post(e);expect(r.replay).toBe(false);
      expect(await counts(e.source.transactionId)).toEqual({headers:1,lines:2,ledger:2});
      const h=(await pool.query("select status,entry_status,journal_id,total_debit::text,total_credit::text from accounting_entries where id=$1",[r.id])).rows[0];
      expect(h).toMatchObject({status:"posted",entry_status:"POSTED",journal_id:1,total_debit:"10000.00",total_credit:"10000.00"});
      const l=(await pool.query("select debit::text,credit::text from accounting_entry_lines where entry_id=$1 and account_id=75839",[r.id])).rows[0];
      expect(l).toEqual(dir==="IN"?{debit:"10000.00",credit:"0.00"}:{debit:"0.00",credit:"10000.00"});
    }
  });
  it("serializes competing UUID and rejects changed approval COA",async()=>{
    const e=evidence(uuid(3));const r=await Promise.all([post(e),post(e)]);
    expect(r.filter(x=>x.replay)).toHaveLength(1);expect(r[0]!.id).toBe(r[1]!.id);
    await expect(post(evidence(uuid(3),"IN",903))).rejects.toThrow("SC_CASH_REPLAY_MISMATCH");
    expect(await counts(uuid(3))).toEqual({headers:1,lines:2,ledger:2});
  });
  it("rolls back all rows on line or silent ledger synchronization failure",async()=>{
    for(const [n,coa,error] of [[4,997,"QA_LINE_FAILURE"],[5,998,"SC_CASH_LEDGER_SYNC_FAILED"]] as const){
      await expect(post(evidence(uuid(n),"IN",coa))).rejects.toThrow(error);
      expect(await counts(uuid(n))).toEqual({headers:0,lines:0,ledger:0});
    }
  });
  it("rejects unapproved voucher and missing dedicated journal",async()=>{
    const e=evidence(uuid(6));await expect(post({...e,approval:null})).rejects.toThrow("SC_CASH_EVIDENCE_MISMATCH");
    await pool.query("update accounting_journals set is_active=false where code='CSH-SC-CST'");
    try{await expect(post(e)).rejects.toThrow("SC_CASH_DEDICATED_JOURNAL_REQUIRED");expect(await counts(uuid(6))).toEqual({headers:0,lines:0,ledger:0});}
    finally{await pool.query("update accounting_journals set is_active=true where code='CSH-SC-CST'");}
  });
});
