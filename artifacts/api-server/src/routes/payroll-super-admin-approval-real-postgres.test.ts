import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { payrollSuperAdminApprovalDigest } from "./payroll-super-admin-approval-receipt";

type DbClient={query:(sql:string,args?:unknown[])=>Promise<{rowCount:number|null;rows:any[]}>;release:()=>void};
const mock=vi.hoisted(()=>({
  pgPool:null as null|{connect:()=>Promise<DbClient>},
  role:"super_admin", companyId:1,
}));
vi.mock("./dev-auth",()=>({isDevelopmentEnvironment:()=>false}));
vi.mock("./payroll-prod-db",()=>({
  getPayrollPool:()=>({connect:()=>mock.pgPool!.connect()}),
  payrollDedicatedEnabled:()=>true,
  payrollProdDedicatedRequired:()=>true,
  payrollReadOnlyReady:()=>true,
  setPayrollCompanyScope:async(c:DbClient,id:number)=>{
    await c.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(id)]);
  },
  payrollScopedQuery:async(id:number,sql:string,args:unknown[])=>{
    const c=await mock.pgPool!.connect();
    try{
      await c.query("BEGIN READ ONLY");
      await c.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(id)]);
      const result=await c.query(sql,args);
      await c.query("COMMIT");
      return result;
    }catch(e){await c.query("ROLLBACK");throw e;}
    finally{c.release();}
  },
}));
import { registerPayrollSuperAdminApprovalRoutes } from "./payroll-super-admin-approval";

const enabled=!!process.env.PAYROLL_PG_E2E_URL;
describe.skipIf(!enabled)("Super Admin approval, real disposable PostgreSQL and HTTP",()=>{
  let pool:typeof import("@workspace/db")["pool"],server:Server,base:string;
  const item={
    id:11,employeeId:101,baseSalary:"5000000.00",allowance:"0.00",
    grossSalary:"5000000.00",bpjsJhtEmployee:"0.00",bpjsKesEmployee:"0.00",
    pph21:"0.00",otherDeductions:"0.00",kasbonDeduction:"100000.00",
    totalDeductions:"100000.00",netSalary:"4900000.00",
  };
  const digest=payrollSuperAdminApprovalDigest(1,32,[item]);
  const post=(id=32,sha=digest)=>fetch(base+"/api/payroll/runs/"+id+"/super-admin-approve",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({confirm:true,expectedDigest:sha,note:"Reviewed by isolated Super Admin"}),
  });
  beforeAll(async()=>{
    const u=new URL(process.env.PAYROLL_PG_E2E_URL!);
    if(u.hostname!=="127.0.0.1"||u.port!=="65432"||u.pathname!=="/payroll_ci"||
      u.username!=="postgres.xssrfshdrtdfupgqwfdw")throw Error("NOT_DISPOSABLE_POSTGRES");
    process.env.APP_ENV="development";
    process.env.SUPABASE_DATABASE_URL_DEV=process.env.PAYROLL_PG_E2E_URL!;
    ({pool}=await import("@workspace/db"));
    mock.pgPool=pool as unknown as NonNullable<typeof mock.pgPool>;
    await pool.query([
      "CREATE TABLE public.payroll_runs (id integer PRIMARY KEY,company_id integer,status text,posting_status text DEFAULT 'pending',accounting_entry_id integer,payment_entry_id integer,approved_at timestamptz,notes text)",
      "CREATE TABLE public.employees (id integer PRIMARY KEY,company_id integer,status text,deleted_at timestamptz,first_name text,last_name text)",
      "CREATE TABLE public.payroll_items (id integer PRIMARY KEY,run_id integer,employee_id integer,is_paid boolean DEFAULT false,base_salary numeric(16,2),allowance numeric(16,2),gross_salary numeric(16,2),bpjs_jht_employee numeric(16,2),bpjs_kes_employee numeric(16,2),pph21 numeric(16,2),other_deductions numeric(16,2),kasbon_deduction numeric(16,2),total_deductions numeric(16,2),net_salary numeric(16,2))",
      "CREATE TABLE public.cash_advances (id integer PRIMARY KEY,company_id integer,employee_id integer,type text,remaining_amount numeric(16,2),status text,lifecycle_status text,approved_at timestamptz,approved_by text,disbursed_at timestamptz,disbursed_by text,accounting_entry_id integer,posting_status text,voided_at timestamptz)",
      "CREATE TABLE public.payroll_kasbon_auto_reservations (id integer PRIMARY KEY,company_id integer,run_id integer,advance_id integer,payroll_item_id integer,employee_id integer,amount numeric(16,2),balance_at_preparation numeric(16,2),state text)",
      "INSERT INTO public.payroll_runs(id,company_id,status) VALUES(32,1,'draft'),(33,2,'draft')",
      "INSERT INTO public.employees(id,company_id,status) VALUES(101,1,'active'),(201,2,'active')",
      "INSERT INTO public.payroll_items(id,run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,total_deductions,net_salary) VALUES(11,32,101,5000000,0,5000000,0,0,0,0,100000,100000,4900000),(12,33,201,5000000,0,5000000,0,0,0,0,0,0,5000000)",
      "INSERT INTO public.cash_advances VALUES(801,1,101,'kasbon',500000,'partial','partially_settled',now(),'admin',now(),'finance',9001,'posted',null)",
      "INSERT INTO public.payroll_kasbon_auto_reservations VALUES(501,1,32,801,11,101,100000,500000,'prepared')",
    ].join(";") + ";");
    process.env.APP_ENV="production";
    const router=Router();
    // Only this isolated test injects actor context; real signed-session authentication is NOT verified.
    router.use((req,_res,next)=>{
      const scoped=req as typeof req&{payrollCompanyId?:number;payrollActor?:{role:string;id:string;email:string}};
      scoped.payrollCompanyId=mock.companyId;
      scoped.payrollActor={role:mock.role,id:"ci-admin",email:"admin@example.test"};
      next();
    });
    registerPayrollSuperAdminApprovalRoutes(router);
    const app=express();app.use(express.json());
    app.use((req,_res,next)=>{req.log={error:vi.fn()} as unknown as typeof req.log;next();});
    app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const a=server.address();if(!a||typeof a==="string")throw Error("NO_TEST_PORT");
    base="http://127.0.0.1:"+a.port;
  });
  afterAll(async()=>{
    delete process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED;
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(pool){await pool.query("DROP TABLE IF EXISTS public.payroll_kasbon_auto_reservations,public.cash_advances,public.payroll_items,public.employees,public.payroll_runs CASCADE");await pool.end();}
  });
  beforeEach(async()=>{
    mock.role="super_admin";mock.companyId=1;
    process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED="true";
    await pool.query("UPDATE public.payroll_runs SET status='draft',approved_at=NULL,notes=NULL WHERE id IN(32,33)");
    await pool.query("UPDATE public.payroll_items SET base_salary=5000000,gross_salary=5000000,net_salary=4900000 WHERE id=11");
    await pool.query("UPDATE public.payroll_kasbon_auto_reservations SET balance_at_preparation=500000 WHERE id=501");
  });
  it("is disabled by default and denies non-Super Admin actor",async()=>{
    process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED="";
    expect((await post()).status).toBe(501);
    process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED="true";
    mock.role="finance";expect((await post()).status).toBe(403);
    const r=await pool.query("SELECT status FROM public.payroll_runs WHERE id=32");
    expect(r.rows[0].status).toBe("draft");
  });
  it("rejects an obsolete digest after persisted salary changes",async()=>{
    await pool.query("UPDATE public.payroll_items SET base_salary=4999999,gross_salary=4999999,net_salary=4899999 WHERE id=11");
    expect((await post()).status).toBe(409);
    const r=await pool.query("SELECT status,approved_at FROM public.payroll_runs WHERE id=32");
    expect(r.rows[0]).toMatchObject({status:"draft",approved_at:null});
  });
  it("rejects a reservation balance mismatch before approval",async()=>{
    await pool.query("UPDATE public.payroll_kasbon_auto_reservations SET balance_at_preparation=400000 WHERE id=501");
    expect((await post()).status).toBe(409);
    const r=await pool.query("SELECT status FROM public.payroll_runs WHERE id=32");
    expect(r.rows[0].status).toBe("draft");
  });
  it("serializes two real concurrent approvals into one reviewed row",async()=>{
    const codes=(await Promise.all([post(),post()])).map(x=>x.status).sort((a,b)=>a-b);
    expect(codes).toEqual([200,409]);
    const r=await pool.query("SELECT status,approved_at,notes FROM public.payroll_runs WHERE id=32");
    expect(r.rows[0].status).toBe("reviewed");
    expect(r.rows[0].approved_at).not.toBeNull();
    expect(String(r.rows[0].notes)).toContain("[PAYROLL_SUPER_ADMIN_APPROVAL_V1]");
    expect((await post()).status).toBe(409);
  });
  it("rolls back the actual PostgreSQL transaction on a trigger error",async()=>{
    await pool.query("CREATE FUNCTION public.ci_fail_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='reviewed' THEN RAISE EXCEPTION 'CI_FAILURE'; END IF; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER ci_fail_approval AFTER UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION public.ci_fail_approval()");
    try{
      expect((await post()).status).toBe(503);
      const r=await pool.query("SELECT status,approved_at,notes FROM public.payroll_runs WHERE id=32");
      expect(r.rows[0]).toMatchObject({status:"draft",approved_at:null,notes:null});
    }finally{
      await pool.query("DROP TRIGGER IF EXISTS ci_fail_approval ON public.payroll_runs");
      await pool.query("DROP FUNCTION IF EXISTS public.ci_fail_approval()");
    }
  });
  it("denies foreign run under a server-scoped company",async()=>{
    expect((await post(33)).status).toBe(404);
    const r=await pool.query("SELECT status,approved_at FROM public.payroll_runs WHERE id=33");
    expect(r.rows[0]).toMatchObject({status:"draft",approved_at:null});
  });
});
