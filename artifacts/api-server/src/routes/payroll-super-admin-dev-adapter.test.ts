import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state=vi.hoisted(()=>({
  devReady:true,prodReady:true,
  devRead:0,prodRead:0,devConnect:0,prodConnect:0,
  actorRole:"super_admin",
  devIdentityRole:null as string|null,
  devIdentityCompany:"1",
  devUpdateAttempts:0,
}));
const sampleItem={
  id:11,employee_id:101,is_paid:false,
  base_salary:"5000000.00",allowance:"0.00",gross_salary:"5000000.00",
  bpjs_jht_employee:"0.00",bpjs_kes_employee:"0.00",pph21:"0.00",
  other_deductions:"0.00",kasbon_deduction:"0.00",
  total_deductions:"0.00",net_salary:"5000000.00",
};
function read(sql:string){
  if(sql.includes("FROM public.payroll_runs WHERE company_id="))return {
    rowCount:1,rows:[{status:"draft",posting_status:"pending",accounting_entry_id:null,
      payment_entry_id:null,approved_at:null,notes:null}],
  };
  if(sql.includes("count(*)::integer AS total FROM public.employees"))return {rowCount:1,rows:[{total:1}]};
  if(sql.includes("FROM public.payroll_items pi"))return {rowCount:1,rows:[sampleItem]};
  if(sql.includes("count(*)::integer AS total FROM public.payroll_items"))return {rowCount:1,rows:[{total:1}]};
  if(sql.includes("FROM public.payroll_kasbon_auto_reservations"))return {rowCount:0,rows:[]};
  throw Error("UNEXPECTED_SQL");
}
vi.mock("./dev-auth",()=>({
  isDevelopmentEnvironment:()=>process.env.APP_ENV==="development",
}));
vi.mock("./payroll-db",()=>({
  payrollDedicatedEnabled:()=>state.devReady,
  payrollScopedQuery:async(_company:number,sql:string,_args:unknown[])=>{
    state.devRead++;return read(sql);
  },

}));
vi.mock("./payroll-dev-approval-db",()=>({
  devApprovalDedicatedEnabled:()=>state.devReady,
  getDevApprovalPool:()=>({connect:async()=>{
    state.devConnect++;
    if(state.devIdentityRole===null)throw Error("TEST_DEV_POOL_REACHED");
    return {query:async(sql:string)=>{
      if(sql.startsWith("UPDATE "))state.devUpdateAttempts++;
      if(sql.startsWith("SELECT current_user"))return {rowCount:1,rows:[{
        role:state.devIdentityRole,company:state.devIdentityCompany,
      }]};
      if(sql==="BEGIN ISOLATION LEVEL READ COMMITTED"||sql==="ROLLBACK")
        return {rowCount:null,rows:[]};
      throw Error("SQL_AFTER_UNVERIFIED_DEV_IDENTITY");
    },release:()=>{}};
  }}),
  setDevApprovalCompanyScope:async()=>{},
}));
vi.mock("./payroll-prod-db",()=>({
  payrollProdDedicatedRequired:()=>state.prodReady,
  payrollReadOnlyReady:()=>state.prodReady,
  payrollScopedQuery:async(_company:number,sql:string,_args:unknown[])=>{
    state.prodRead++;return read(sql);
  },
  getPayrollPool:()=>({connect:async()=>{state.prodConnect++;throw Error("TEST_PROD_POOL_REACHED");}}),
  setPayrollCompanyScope:async()=>{},
}));
import { registerPayrollSuperAdminApprovalRoutes } from "./payroll-super-admin-approval";

describe("Unmounted Super Admin approval selects existing environment-specific Payroll adapter",()=>{
  let server:Server;let base:string;
  beforeAll(async()=>{
    const router=Router();
    // Synthetic actor for adapter-selection test ONLY, not a signed-session test.
    router.use((req,_res,next)=>{
      const scoped=req as typeof req&{payrollActor?:{id:string;email:string;role:string};payrollCompanyId?:number};
      scoped.payrollActor={id:"ci-admin",email:"ci-admin@example.test",role:state.actorRole};
      scoped.payrollCompanyId=1;
      next();
    });
    registerPayrollSuperAdminApprovalRoutes(router);
    const app=express();app.use(express.json());
    app.use((req,_res,next)=>{req.log={error:vi.fn()} as unknown as typeof req.log;next();});
    app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const address=server.address();if(!address||typeof address==="string")throw Error("NO_TEST_PORT");
    base="http://127.0.0.1:"+address.port;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED","");
    vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","");
    state.devReady=true;state.prodReady=true;state.actorRole="super_admin";
    state.devRead=0;state.prodRead=0;state.devConnect=0;state.prodConnect=0;
    state.devIdentityRole=null;state.devIdentityCompany="1";state.devUpdateAttempts=0;
  });
  afterEach(()=>vi.unstubAllEnvs());
  const preview=()=>fetch(base+"/api/payroll/runs/32/super-admin-approval-preview");
  const approve=()=>fetch(base+"/api/payroll/runs/32/super-admin-approve",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({confirm:true,expectedDigest:"a".repeat(64),note:"Synthetic developer approval review"}),
  });
  it("reads preview in DEV using only DEV Payroll adapter, with approval OFF",async()=>{
    const res=await preview();expect(res.status).toBe(200);
    const payload=await res.json() as {canApprove:boolean;blockedReasons:string[]};
    expect(payload.canApprove).toBe(false);
    expect(payload.blockedReasons).toContain("SUPER_ADMIN_APPROVAL_DISABLED");
    expect(state.devRead).toBeGreaterThan(0);
    expect(state.prodRead).toBe(0);
    expect(state.devConnect+state.prodConnect).toBe(0);
  });
  it("fails closed in DEV if dedicated Payroll role is not configured",async()=>{
    state.devReady=false;
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED","true");
    expect((await approve()).status).toBe(501);
    expect((await preview()).status).toBe(503);
    expect(state.devConnect+state.prodConnect+state.devRead+state.prodRead).toBe(0);
  });
  it("routes opted-in DEV approval to its dedicated pool, never PROD pool",async()=>{
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED","true");
    expect((await approve()).status).toBe(503); // test pool intentionally unavailable
    expect(state.devConnect).toBe(1);
    expect(state.prodConnect).toBe(0);
  });
  it("refuses the legacy DEV Payroll login before any approval UPDATE",async()=>{
    state.devIdentityRole="bizportal_payroll_dev";
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED","true");
    expect((await approve()).status).toBe(503);
    expect(state.devConnect).toBe(1);
    expect(state.devUpdateAttempts).toBe(0);
  });
  it("refuses an approver-role claim with mismatched company scope",async()=>{
    state.devIdentityRole="bizportal_payroll_approver_dev";
    state.devIdentityCompany="2";
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED","true");
    expect((await approve()).status).toBe(503);
    expect(state.devUpdateAttempts).toBe(0);
  });
  it("does not enable PROD approval via the DEV flag",async()=>{
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED","true");
    expect((await approve()).status).toBe(501);
    expect(state.devConnect+state.prodConnect).toBe(0);
  });
  it("keeps PROD adapter selection intact when its separate flag is enabled",async()=>{
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","true");
    expect((await approve()).status).toBe(503); // test pool intentionally unavailable
    expect(state.prodConnect).toBe(1);
    expect(state.devConnect).toBe(0);
  });
  it("rejects a non-Super Admin even when DEV is configured",async()=>{
    state.actorRole="finance";
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED","true");
    expect((await approve()).status).toBe(403);
    expect(state.devConnect+state.prodConnect).toBe(0);
  });
});
