import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { hash } from "bcryptjs";
import { payrollSuperAdminApprovalDigest } from "./payroll-super-admin-approval-receipt";

/**
 * Test-only composition of the real email/password login, real HMAC session
 * cookie, real production Payroll authorize middleware, and the legacy approval
 * route which REMAINS UNMOUNTED in the application. Disposable PostgreSQL only.
 */
const enabled=Boolean(process.env.PAYROLL_PG_E2E_URL);
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:any[];rowCount:number|null}>;release:()=>void};
const shared=vi.hoisted(()=>({
  pool:null as null|{query:(sql:string,args?:unknown[])=>Promise<{rows:any[];rowCount:number|null}>;
    connect:()=>Promise<Client>;end:()=>Promise<void>},
  role:"ci_payroll_approver",
}));
vi.mock("@workspace/db",async(importOriginal)=>{
  const real=await importOriginal<typeof import("@workspace/db")>();
  return {...real,pool:{
    query:(sql:string,args?:unknown[])=>shared.pool!.query(sql,args),
    connect:()=>shared.pool!.connect(),
    end:()=>shared.pool!.end(),
  }};
});
vi.mock("./payroll-prod-db",()=>({
  payrollReadOnlyReady:()=>true,
  payrollDedicatedEnabled:()=>true,
  payrollProdDedicatedRequired:()=>true,
  payrollProdSharedReadOnlyEnabled:()=>false,
  getPayrollPool:()=>({connect:()=>shared.pool!.connect()}),
  setPayrollCompanyScope:async(client:Client,companyId:number)=>{
    if(!Number.isSafeInteger(companyId)||companyId<1)throw Error("INVALID_CI_SCOPE");
    if(!["ci_payroll_approver","ci_payroll_readonly"].includes(shared.role))throw Error("INVALID_CI_ROLE");
    await client.query("SET LOCAL ROLE "+shared.role);
    await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
    const check=await client.query("SELECT current_user role,current_setting('app.payroll_company_id',true) company");
    if(check.rows[0]?.role!==shared.role||check.rows[0]?.company!==String(companyId))
      throw Error("CI_ROLE_SCOPE_NOT_VERIFIED");
  },
  payrollScopedQuery:async(companyId:number,sql:string,args:unknown[])=>{
    const client=await shared.pool!.connect();
    try{
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL ROLE "+shared.role);
      await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
      const result=await client.query(sql,args);
      await client.query("COMMIT");
      return result;
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}
    finally{client.release();}
  },
}));

describe.skipIf(!enabled)("signed production Payroll Super Admin + scoped disposable PostgreSQL",()=>{
  let server:Server,base:string;
  let superCookie="",financeCookie="";
  const companyOne=1,companyTwo=2;
  const superEmail="ci-super-admin@example.test";
  const financeEmail="ci-finance@example.test";
  const password="ci-only-disposable-password";
  const request=(route:string,cookie?:string,method="GET",body?:unknown)=>fetch(base+route,{
    method,headers:{
      ...(cookie?{cookie}:{}),
      ...(body!==undefined?{"content-type":"application/json"}:{}),
    },
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
  });
  const login=async(email:string,pass=password)=>{
    const res=await request("/api/auth/email-login",undefined,"POST",{email,password:pass});
    return {status:res.status,cookie:(res.headers.get("set-cookie")??"").split(";")[0]};
  };
  const payrollItem={
    id:11,employeeId:101,baseSalary:"5000000.00",allowance:"0.00",
    grossSalary:"5000000.00",bpjsJhtEmployee:"0.00",bpjsKesEmployee:"0.00",
    pph21:"0.00",otherDeductions:"0.00",kasbonDeduction:"100000.00",
    totalDeductions:"100000.00",netSalary:"4900000.00",
  };
  const digest=payrollSuperAdminApprovalDigest(companyOne,32,[payrollItem]);
  const approve=(cookie:string,id=32,companyId=companyOne,d=digest)=>
    request("/api/payroll/runs/"+id+"/super-admin-approve?companyId="+companyId,
      cookie,"POST",{confirm:true,expectedDigest:d,note:"Signed Super Admin approved synthetic payroll"});
  beforeAll(async()=>{
    const u=new URL(process.env.PAYROLL_PG_E2E_URL!);
    if(u.protocol!=="postgresql:"||u.hostname!=="127.0.0.1"||u.port!=="65432"||
      u.pathname!=="/payroll_ci"||u.username!=="postgres.xssrfshdrtdfupgqwfdw")
      throw Error("REFUSE_NON_DISPOSABLE_DATABASE");
    process.env.APP_ENV="production";
    process.env.NODE_ENV="test";
    process.env.BIZPORTAL_SESSION_SECRET="ci-only-hmac-secret-isolated-not-production-00000001";
    process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED="true";
    const {createDedicatedPayrollPool}=await import("@workspace/db");
    shared.pool=createDedicatedPayrollPool(process.env.PAYROLL_PG_E2E_URL!) as unknown as NonNullable<typeof shared.pool>;
    const db=shared.pool;
    const ddl=[
      "CREATE TABLE public.users (id text primary key,email text,role text,company_id integer,status text,is_active boolean,password_hash text)",
      "CREATE TABLE public.payroll_runs (id integer primary key,company_id integer,status text,posting_status text default 'pending',accounting_entry_id integer,payment_entry_id integer,approved_at timestamptz,notes text)",
      "CREATE TABLE public.employees (id integer primary key,company_id integer,status text,deleted_at timestamptz,first_name text,last_name text)",
      "CREATE TABLE public.payroll_items (id integer primary key,run_id integer,employee_id integer,is_paid boolean default false,base_salary numeric(16,2),allowance numeric(16,2),gross_salary numeric(16,2),bpjs_jht_employee numeric(16,2),bpjs_kes_employee numeric(16,2),pph21 numeric(16,2),other_deductions numeric(16,2),kasbon_deduction numeric(16,2),total_deductions numeric(16,2),net_salary numeric(16,2))",
      "CREATE TABLE public.cash_advances (id integer primary key,company_id integer,employee_id integer,type text,remaining_amount numeric(16,2),status text,lifecycle_status text,approved_at timestamptz,approved_by text,disbursed_at timestamptz,disbursed_by text,accounting_entry_id integer,posting_status text,voided_at timestamptz)",
      "CREATE TABLE public.payroll_kasbon_auto_reservations (id integer primary key,company_id integer,run_id integer,advance_id integer,payroll_item_id integer,employee_id integer,amount numeric(16,2),balance_at_preparation numeric(16,2),state text)",
    ];
    for(const sql of ddl)await db.query(sql);
    const pwHash=await hash(password,4);
    await db.query("INSERT INTO public.users VALUES($1,$2,'super_admin',NULL,'active',true,$3)",["superadmin-1",superEmail,pwHash]);
    await db.query("INSERT INTO public.users VALUES($1,$2,'finance',1,'active',true,$3)",["finance-1",financeEmail,pwHash]);
    await db.query("INSERT INTO public.payroll_runs(id,company_id,status) VALUES(32,1,'draft'),(33,2,'draft')");
    await db.query("INSERT INTO public.employees(id,company_id,status) VALUES(101,1,'active'),(201,2,'active')");
    await db.query("INSERT INTO public.payroll_items(id,run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,total_deductions,net_salary) VALUES(11,32,101,5000000,0,5000000,0,0,0,0,100000,100000,4900000),(12,33,201,5000000,0,5000000,0,0,0,0,0,0,5000000)");
    await db.query("INSERT INTO public.cash_advances VALUES(801,1,101,'kasbon',500000,'partial','partially_settled',now(),'verified',now(),'finance',9001,'posted',null)");
    await db.query("INSERT INTO public.payroll_kasbon_auto_reservations VALUES(501,1,32,801,11,101,100000,500000,'prepared')");

    await db.query("CREATE ROLE ci_payroll_readonly NOLOGIN NOBYPASSRLS");
    await db.query("CREATE ROLE ci_payroll_approver NOLOGIN NOBYPASSRLS");
    for(const role of ["ci_payroll_readonly","ci_payroll_approver"]){
      await db.query("GRANT USAGE ON SCHEMA public TO "+role);
      await db.query("GRANT SELECT ON public.payroll_runs,public.employees,public.payroll_items,public.cash_advances,public.payroll_kasbon_auto_reservations TO "+role);
    }
    await db.query("GRANT UPDATE(status,approved_at,notes) ON public.payroll_runs TO ci_payroll_approver");
    for(const table of ["payroll_runs","employees","cash_advances","payroll_kasbon_auto_reservations"]){
      await db.query("ALTER TABLE public."+table+" ENABLE ROW LEVEL SECURITY");
      await db.query("CREATE POLICY ci_"+table+"_scope ON public."+table+" FOR ALL TO ci_payroll_readonly,ci_payroll_approver USING (company_id = NULLIF(current_setting('app.payroll_company_id',true),'')::integer) WITH CHECK (company_id = NULLIF(current_setting('app.payroll_company_id',true),'')::integer)");
    }
    await db.query("ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY");
    await db.query("CREATE POLICY ci_payroll_items_scope ON public.payroll_items FOR ALL TO ci_payroll_readonly,ci_payroll_approver USING (EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.id=run_id AND r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)) WITH CHECK (EXISTS (SELECT 1 FROM public.payroll_runs r WHERE r.id=run_id AND r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer))");

    const {default:auth}=await import("./local-production-auth");
    const {default:payrollRouter}=await import("./payroll");
    const {registerPayrollSuperAdminApprovalRoutes}=await import("./payroll-super-admin-approval");
    const testOnlyApproval=Router();
    registerPayrollSuperAdminApprovalRoutes(testOnlyApproval);
    const app=express();
    app.use((req,_res,next)=>{req.log={error:vi.fn(),info:vi.fn()} as unknown as typeof req.log;next();});
    app.use(express.json());
    app.use("/api",auth);
    app.use("/api",payrollRouter); // REAL signed-cookie + DB-user + tenant authorization
    app.use("/api",testOnlyApproval); // TEST-ONLY; not mounted in shipped app
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const a=server.address();if(!a||typeof a==="string")throw Error("NO_TEST_LISTENER");
    base="http://127.0.0.1:"+a.port;
    const admin=await login(superEmail),finance=await login(financeEmail);
    expect(admin.status).toBe(200);expect(finance.status).toBe(200);
    superCookie=admin.cookie;financeCookie=finance.cookie;
    expect(superCookie).toContain("bizportal_supabase_session=");
  });
  afterAll(async()=>{
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(shared.pool)await shared.pool.end();
    shared.pool=null;
    delete process.env.BIZPORTAL_SESSION_SECRET;
    delete process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED;
  });
  beforeEach(async()=>{
    shared.role="ci_payroll_approver";
    const db=shared.pool!;
    await db.query("UPDATE public.users SET is_active=true,status='active',role=CASE WHEN email=$1 THEN 'super_admin' ELSE 'finance' END",[superEmail]);
    await db.query("UPDATE public.payroll_runs SET status='draft',approved_at=NULL,notes=NULL WHERE id IN (32,33)");
  });
  it("uses actual login HMAC cookie and denies missing, corrupted or wrong-password sessions",async()=>{
    expect((await approve("")).status).toBe(401);
    const tampered=superCookie.slice(0,-1)+(superCookie.endsWith("A")?"B":"A");
    expect((await approve(tampered)).status).toBe(401);
    const failed=await login(superEmail,"wrong-password");
    expect(failed.status).toBe(401);
    expect(failed.cookie).not.toContain("bizportal_supabase_session=");
    expect((await shared.pool!.query("SELECT status FROM public.payroll_runs WHERE id=32")).rows[0].status).toBe("draft");
  });
  it("revalidates the DB actor and denies finance/downgraded/deactivated Super Admin",async()=>{
    expect((await approve(financeCookie)).status).toBe(403);
    await shared.pool!.query("UPDATE public.users SET role='finance' WHERE email=$1",[superEmail]);
    expect((await approve(superCookie)).status).toBe(403);
    await shared.pool!.query("UPDATE public.users SET role='super_admin',is_active=false WHERE email=$1",[superEmail]);
    expect((await approve(superCookie)).status).toBe(401);
  });
  it("uses server-checked company scope and rejects a foreign run",async()=>{
    expect((await approve(superCookie,33,companyOne)).status).toBe(404);
    const row=await shared.pool!.query("SELECT status FROM public.payroll_runs WHERE id=33");
    expect(row.rows[0].status).toBe("draft");
    expect((await approve(financeCookie,32,companyTwo)).status).toBe(403);
  });
  it("proves the read-only database role cannot update an approval",async()=>{
    shared.role="ci_payroll_readonly";
    const res=await approve(superCookie);
    expect(res.status).toBe(503);
    expect((await shared.pool!.query("SELECT status,approved_at FROM public.payroll_runs WHERE id=32")).rows[0])
      .toMatchObject({status:"draft",approved_at:null});
  });
  it("allows one approval only under the artificial scoped writer role (not PROD)",async()=>{
    const res=await approve(superCookie);
    expect(res.status).toBe(200);
    const result=await res.json() as Record<string,unknown>;
    expect(result).toMatchObject({oneSuperAdminApproval:true,readyForPayment:false,accountingPosted:false,paid:false});
    expect((await approve(superCookie)).status).toBe(409);
    const row=await shared.pool!.query("SELECT status,approved_at,notes FROM public.payroll_runs WHERE id=32");
    expect(row.rows[0].status).toBe("reviewed");
    expect(row.rows[0].approved_at).not.toBeNull();
    expect(String(row.rows[0].notes)).toContain("[PAYROLL_SUPER_ADMIN_APPROVAL_V1]");
  });
});
