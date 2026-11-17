import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Response } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

type Queryable={ query:(sql:string,args?:unknown[])=>Promise<any>; connect:()=>Promise<any>; end:()=>Promise<void> };
const fixture=vi.hoisted(()=>({
 admin:null as Queryable|null,
 calculate:null as Queryable|null,
 approve:null as Queryable|null,
}));

// Only the CONNECTOR/pool-custody boundary is substituted: all three
// PostgreSQL pools authenticate with their actual separate fixture logins.
// Router, HMAC session, real user lookup, Calculate, approval and SQL are real.
vi.mock("@workspace/db",async(importOriginal)=>{
 const original=await importOriginal<typeof import("@workspace/db")>();
 return {...original,pool:{
  query:(sql:string,args?:unknown[])=>fixture.admin!.query(sql,args),
  connect:()=>fixture.admin!.connect(),
 }};
});
vi.mock("./payroll-db",()=>({
 payrollDedicatedEnabled:()=>fixture.calculate!==null,
 getPayrollPool:()=>fixture.calculate,
 setPayrollCompanyScope:async(client:any,companyId:number)=>{
  await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
 },
 payrollScopedQuery:async(companyId:number,sql:string,args:unknown[])=>{
  const client=await fixture.calculate!.connect();
  try{
   await client.query("BEGIN READ ONLY");
   await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
   const result=await client.query(sql,args);
   await client.query("COMMIT");
   return result;
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}
  finally{client.release();}
 },
}));
vi.mock("./payroll-dev-approval-db",()=>({
 devApprovalDedicatedEnabled:()=>fixture.approve!==null,
 getDevApprovalPool:()=>fixture.approve,
 setDevApprovalCompanyScope:async(client:any,companyId:number)=>{
  await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
 },
}));

const postgresUrl=process.env.PAYROLL_CALC_PG_ADMIN_URL;
const calculateUrl=process.env.PAYROLL_CALC_PG_RESTRICTED_URL;
const approveUrl=process.env.PAYROLL_CALC_PG_APPROVER_URL;
const run=describe.skipIf(!postgresUrl||!calculateUrl||!approveUrl);
run("one real signed HTTP Calculate -> Super Admin approval on disposable PostgreSQL",()=>{
 let server:Server, base:string;
 let createSessionCookie:(response:Response,session:{
   id:string;email:string;issuedAt:number;expiresAt:number
 })=>void;
 const secret="synthetic-only-payroll-hmac-session-secret-2026-long";
 const origin="http://127.0.0.1:19002";
 const check=(raw:string|undefined,role:string)=>{
  if(!raw)return false;
  try{const u=new URL(raw);
   return u.protocol==="postgresql:"&&u.hostname==="127.0.0.1"&&
    u.port==="65436"&&u.pathname==="/postgres"&&
    u.username===role&&Boolean(u.password);
  }catch{return false;}
 };
 const cookie=(id="ci-super-1",email="payroll-ci-super@example.test",
   expiresAt=Date.now()+120_000)=>{
  let value="";
  const response={append:(name:string,part:string)=>{
   if(name==="Set-Cookie")value=part;
   return response;
  }} as unknown as Response;
  createSessionCookie(response,{id,email,issuedAt:Date.now()-30_000,expiresAt});
  return value.split(";")[0];
 };
 const request=async(path:string,whichCookie:string|null,method:"GET"|"POST"="GET",payload?:unknown)=>{
  const headers:Record<string,string>={Origin:origin};
  if(whichCookie)headers.cookie=whichCookie;
  if(method==="POST")headers["content-type"]="application/json";
  return fetch(base+path,{method,headers,
   ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
 };
 const cal=(whichCookie:string|null,runId=32,company=1)=>
  request("/api/payroll/runs/"+runId+"/calculate?companyId="+company,whichCookie,"POST",{});
 const preview=(whichCookie:string|null,runId=32,company=1)=>
  request("/api/payroll/runs/"+runId+"/super-admin-approval-preview?companyId="+company,whichCookie);
 const approval=(whichCookie:string|null,digest:string,runId=32,company=1)=>
  request("/api/payroll/runs/"+runId+"/super-admin-approve?companyId="+company,
    whichCookie,"POST",{confirm:true,expectedDigest:digest,
     note:"Synthetic Super Admin approved payroll in disposable test"});

 beforeAll(async()=>{
  if(!check(postgresUrl,"postgres")||
     !check(calculateUrl,"bizportal_payroll_dev")||
     !check(approveUrl,"bizportal_payroll_approver_dev"))
   throw Error("REFUSE_NON_DISPOSABLE_POSTGRES");
  // All feature switches are test-process-only; no active service is changed.
  vi.stubEnv("APP_ENV","development");
  vi.stubEnv("NODE_ENV","test");
  vi.stubEnv("SESSION_SECRET",secret);
  vi.stubEnv("BIZPORTAL_SESSION_SECRET","");
  vi.stubEnv("BIZPORTAL_SIGNED_OTP_ENABLED_DEV","true");
  vi.stubEnv("BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV","");
  vi.stubEnv("PAYROLL_DEV_CALCULATE_ENABLED","true");
  vi.stubEnv("PAYROLL_DEV_CALCULATE_ALLOWED_ORIGIN",origin);
  vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED","true");
  vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED","true");
  vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED","");
  vi.stubEnv("PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED","");
  fixture.admin=new Pool({connectionString:postgresUrl,max:2});
  const baseSchema=readFileSync(new URL("../../../../scripts/payroll-calculate/disposable-schema.sql",import.meta.url),"utf8");
  const approvalSchema=readFileSync(new URL("../../../../scripts/payroll-calculate/signed-approval-fixture.sql",import.meta.url),"utf8");
  await fixture.admin.query(baseSchema);
  await fixture.admin.query(approvalSchema);
  fixture.calculate=new Pool({connectionString:calculateUrl,max:2});
  fixture.approve=new Pool({connectionString:approveUrl,max:1});
  const {default:router}=await import("./payroll");
  const {setProductionSessionCookie}=await import("./dev-auth");
  createSessionCookie=setProductionSessionCookie;
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{
   (req as any).log={error:()=>undefined,warn:()=>undefined};
   next();
  });
  app.use("/api",router);
  server=createServer(app);
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("TEST_HTTP_BIND");
  base="http://127.0.0.1:"+address.port;
 },30000);
 beforeEach(async()=>{
  await fixture.admin!.query(`TRUNCATE TABLE
   public.payroll_kasbon_auto_reservations,public.payroll_kasbon_auto_plans,
   public.payroll_cash_advance_allocations,public.cash_advance_installment_schedules,
   public.cash_advances,public.payroll_items,public.payroll_runs,public.employees
   RESTART IDENTITY CASCADE`);
  await fixture.admin!.query(`UPDATE public.users
   SET role=CASE id WHEN 'ci-super-1' THEN 'super_admin'
    WHEN 'ci-owner-1' THEN 'owner' ELSE 'finance' END,
    is_active=true,status='active'`);
  await fixture.admin!.query(`
   INSERT INTO public.employees (id,company_id,status) VALUES
      (101,1,'active'),(201,3,'active');
   INSERT INTO public.payroll_runs (id,company_id,month,year,status,posting_status)
    VALUES (32,1,11,2026,'draft','pending'),(33,3,11,2026,'draft','pending');
   INSERT INTO public.payroll_items(id,run_id,employee_id,is_paid,
    base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,
    pph21,other_deductions,kasbon_deduction,total_deductions,net_salary)
    VALUES (11,32,101,false,3000,0,3000,0,0,0,0,0,0,3000),
           (22,33,201,false,4000,0,4000,0,0,0,0,0,0,4000);
   INSERT INTO public.cash_advances(id,company_id,employee_id,type,status,lifecycle_status,
    currency,amount,paid_amount,settled_amount,remaining_amount,
    approved_at,approved_by,disbursed_at,disbursed_by,accounting_entry_id,posting_status)
    VALUES (801,1,101,'kasbon','approved','outstanding','IDR',1000,300,200,500,
     '2026-10-01','approver','2026-10-02','treasury',555,'posted'),
     (802,3,201,'kasbon','approved','outstanding','IDR',2000,100,0,1900,
     '2026-10-01','approver','2026-10-02','treasury',556,'posted');
   INSERT INTO public.payroll_kasbon_auto_plans
    (company_id,employee_id,advance_id,choice,installment_amount,first_period)
    VALUES (1,101,801,'INSTALLMENT',100,'2026-11-01'),
     (3,201,802,'FULL',NULL,'2026-11-01');`);
 },15000);
 afterAll(async()=>{
  if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await Promise.allSettled([fixture.calculate?.end(),fixture.approve?.end(),fixture.admin?.end()]);
  vi.unstubAllEnvs();
 });

 it("signed Super Admin completes Calculate and ONE receipt approval on real separate restricted roles",async()=>{
  const signed=cookie();
  const calculated=await cal(signed);
  expect(calculated.status).toBe(200);
  const value=await calculated.json() as any;
  expect(value).toMatchObject({status:"draft",net:"2900.00",
   preparedReservations:1,accountingPosted:false,approved:false,salaryPaid:false});
  const approvalPreview=await preview(signed);
  expect(approvalPreview.status).toBe(200);
  const p=await approvalPreview.json() as any;
  expect(p).toMatchObject({canApprove:true,kasbonReservationVerified:true,
   gross:"3000.00",net:"2900.00",digest:value.digest});
  const accepted=await approval(signed,p.digest);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({oneSuperAdminApproval:true,
   status:"reviewed",accountingPosted:false,paid:false});
  // The narrow RLS UPDATE policy hides already-reviewed rows from SELECT FOR UPDATE.
  // A repeated request must be rejected even if the safe response is 404, not 409.
  expect((await approval(signed,p.digest)).status).toBe(404);
  expect((await cal(signed)).status).toBe(404);
  const read=await fixture.admin!.query(`SELECT
    (SELECT status FROM public.payroll_runs WHERE id=32) status,
    (SELECT approved_at IS NOT NULL FROM public.payroll_runs WHERE id=32) approved,
    (SELECT count(*)::integer FROM public.payroll_kasbon_auto_reservations WHERE run_id=32 AND state='prepared') holds,
    (SELECT remaining_amount::text FROM public.cash_advances WHERE id=801) balance,
    (SELECT settled_amount::text FROM public.cash_advances WHERE id=801) settled,
    (SELECT count(*)::integer FROM public.payroll_kasbon_auto_reservations WHERE company_id=3) foreign_holds`);
  expect(read.rows[0]).toMatchObject({status:"reviewed",approved:true,holds:1,
   balance:"500",settled:"200",foreign_holds:0});
 });
 it("rejects forged, absent, expired, Owner and Finance signed sessions before any Calculate",async()=>{
  const valid=cookie();
  expect((await cal(null)).status).toBe(401);
  const forged=valid.slice(0,-1)+(valid.endsWith("a")?"b":"a");
  expect((await cal(forged)).status).toBe(401);
  const expired=cookie("ci-super-1","payroll-ci-super@example.test",Date.now()-1000);
  expect((await cal(expired)).status).toBe(401);
  // Valid HMAC but the database user has been disabled: session is insufficient.
  await fixture.admin!.query("UPDATE public.users SET is_active=false WHERE id='ci-super-1'");
  expect((await cal(valid)).status).toBe(403);
  expect((await cal(cookie("ci-owner-1","payroll-ci-owner@example.test"))).status).toBe(403);
  expect((await cal(cookie("ci-finance-1","payroll-ci-finance@example.test"))).status).toBe(403);
  const holds=await fixture.admin!.query("SELECT count(*)::integer n FROM public.payroll_kasbon_auto_reservations");
  expect(holds.rows[0].n).toBe(0);
 });
 it("enforces scoped foreign-company run denial and no cross-company holds",async()=>{
  const signed=cookie();
  expect((await cal(signed,33,1)).status).toBe(404);
  expect((await cal(signed,32,3)).status).toBe(404);
  expect((await preview(signed,33,1)).status).toBe(404);
  const r=await fixture.admin!.query("SELECT count(*)::integer n FROM public.payroll_kasbon_auto_reservations");
  expect(r.rows[0].n).toBe(0);
 });
 it("refuses stale data digest and leaves Draft unapproved with prepared reservation",async()=>{
  const signed=cookie();
  expect((await cal(signed)).status).toBe(200);
  const p=await preview(signed);
  const old=(await p.json() as any).digest as string;
  // Synthetic concurrent edit under fixture admin; not application approval.
  await fixture.admin!.query(`UPDATE public.payroll_items
    SET allowance=50,gross_salary=3050,net_salary=2950 WHERE id=11`);
  const stale=await approval(signed,old);
  expect(stale.status).toBe(409);
  const run=await fixture.admin!.query("SELECT status,approved_at,notes FROM public.payroll_runs WHERE id=32");
  expect(run.rows[0]).toMatchObject({status:"draft",approved_at:null,notes:null});
 });
 it("separate approver role has no salary item, cash advance or ledger write privileges",async()=>{
  const r=await fixture.admin!.query(`SELECT
   has_table_privilege('bizportal_payroll_approver_dev','public.payroll_items','UPDATE') item_update,
   has_table_privilege('bizportal_payroll_approver_dev','public.cash_advances','UPDATE') advance_update,
   has_table_privilege('bizportal_payroll_approver_dev','public.payroll_runs','UPDATE') broad_run_update,
   has_column_privilege('bizportal_payroll_approver_dev','public.payroll_runs','approved_at','UPDATE') approval_update`);
  expect(r.rows[0]).toMatchObject({item_update:false,advance_update:false,broad_run_update:false,approval_update:true});
 });
});
