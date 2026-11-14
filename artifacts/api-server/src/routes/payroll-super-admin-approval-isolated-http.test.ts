import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { payrollSuperAdminApprovalDigest } from "./payroll-super-admin-approval-receipt";
import type { PayrollPreviewItem } from "./payroll-preview";

const state=vi.hoisted(()=>({
  role:"super_admin",actorId:"verified-admin",actorEmail:"admin@example.test",companyId:1,
  enabled:false,dedicated:true, invalidHold:false, incomplete:false, failReadback:false,
  runStatus:"draft",approvedAt:null as null|string,notes:null as null|string,
  dbQueries:[] as Array<{sql:string;values:unknown[]}>,
  calls:[] as string[], committed:0,rolledBack:0,updates:0, checkout:0,
}));
const item:PayrollPreviewItem={
  id:11,employeeId:101,
  baseSalary:"5000000.00",allowance:"0.00",grossSalary:"5000000.00",
  bpjsJhtEmployee:"0.00",bpjsKesEmployee:"0.00",pph21:"0.00",
  otherDeductions:"0.00",kasbonDeduction:"100000.00",
  totalDeductions:"100000.00",netSalary:"4900000.00",
};
const digest=payrollSuperAdminApprovalDigest(1,32,[item]);
const dbItem={
  id:11,employee_id:101,is_paid:false,base_salary:item.baseSalary,
  allowance:item.allowance,gross_salary:item.grossSalary,
  bpjs_jht_employee:item.bpjsJhtEmployee,bpjs_kes_employee:item.bpjsKesEmployee,
  pph21:item.pph21,other_deductions:item.otherDeductions,
  kasbon_deduction:item.kasbonDeduction,total_deductions:item.totalDeductions,
  net_salary:item.netSalary,
};
function dbResult(sql:string,values:unknown[]) {
  if(sql.includes("FROM public.payroll_runs")&&sql.includes("FOR UPDATE"))return {
    rowCount:1,rows:[{status:state.runStatus,posting_status:"pending",
      accounting_entry_id:null,payment_entry_id:null,approved_at:state.approvedAt,notes:state.notes}],
  };
  if(sql.includes("FROM public.payroll_runs"))return {
    rowCount:1,rows:[{status:state.runStatus,posting_status:"pending",
      accounting_entry_id:null,payment_entry_id:null,approved_at:state.approvedAt,notes:state.notes}],
  };
  if(sql.includes("count(*)::integer AS total FROM public.employees"))return {
    rowCount:1,rows:[{total:state.incomplete?2:1}],
  };
  if(sql.includes("FROM public.payroll_items pi"))return {rowCount:1,rows:[dbItem]};
  if(sql.includes("count(*)::integer AS total FROM public.payroll_items"))return {rowCount:1,rows:[{total:1}]};
  if(sql.includes("FROM public.payroll_kasbon_auto_reservations"))return {rowCount:state.invalidHold?0:1,rows:state.invalidHold?[]:[{
    payrollItemId:11,employeeId:101,amount:"100000.00",
    heldBalance:"500000.00",currentBalance:"500000.00",
    advanceStatus:"partial",advanceLifecycle:"partially_settled",
    advanceApprovedAt:"2026-10-01",advanceApprovedBy:"super-admin",
    advanceDisbursedAt:"2026-10-02",advanceDisbursedBy:"finance",
    advanceAccountingEntryId:9001,advancePostingStatus:"posted",
    advanceVoidedAt:null,state:"prepared",
  }]};
  if(sql.includes("UPDATE public.payroll_runs")){
    state.updates++;
    return state.failReadback?{rowCount:1,rows:[{id:32,status:"reviewed",approved_at:null,notes:values[2]}]}:
      {rowCount:1,rows:[{id:32,status:"reviewed",approved_at:"2026-11-14T16:00:00Z",notes:values[2]}]};
  }
  throw Error("Unexpected SQL query in isolated test");
}
const client={
  query:async(sql:string,values:unknown[]=[])=>{
    state.calls.push(sql);state.dbQueries.push({sql,values});
    if(sql==="COMMIT"){state.committed++;state.runStatus="reviewed";state.approvedAt="2026-11-14T16:00:00Z";return {rowCount:0,rows:[]};}
    if(sql==="ROLLBACK"){state.rolledBack++;return {rowCount:0,rows:[]};}
    if(sql.startsWith("BEGIN")||sql.startsWith("SELECT pg_advisory_xact_lock"))return {rowCount:0,rows:[]};
    return dbResult(sql,values);
  },
  release:()=>{},
};
vi.mock("./payroll-prod-db",()=>({
  getPayrollPool:()=>({connect:async()=>{state.checkout++;return client;}}),
  payrollDedicatedEnabled:()=>state.dedicated,
  payrollProdDedicatedRequired:()=>state.dedicated,
  payrollReadOnlyReady:()=>state.dedicated,
  payrollScopedQuery:async(_companyId:number,sql:string,values:unknown[]=[])=>dbResult(sql,values),
  setPayrollCompanyScope:async(_client:unknown,companyId:number)=>{
    state.calls.push("SET_SCOPE_"+companyId);
  },
}));
vi.mock("./dev-auth",()=>({isDevelopmentEnvironment:()=>false}));
import { registerPayrollSuperAdminApprovalRoutes } from "./payroll-super-admin-approval";

describe("Unmounted legacy Payroll Super Admin approval — isolated HTTP contract",()=>{
  let server:Server,root:string;
  beforeAll(async()=>{
    const router=Router();
    router.use((req,_res,next)=>{
      const scoped=req as typeof req & {
        payrollActor?:{id:string;email:string;role:string};
        payrollCompanyId?:number;
      };
      scoped.payrollActor={id:state.actorId,email:state.actorEmail,role:state.role};
      scoped.payrollCompanyId=state.companyId;
      next();
    });
    registerPayrollSuperAdminApprovalRoutes(router);
    const app=express();app.use(express.json());app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const a=server.address();if(!a||typeof a==="string")throw Error("NO_PORT");
    root="http://127.0.0.1:"+a.port;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","production");vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","");
    state.role="super_admin";state.actorId="verified-admin";state.actorEmail="admin@example.test";
    state.companyId=1;state.enabled=false;state.dedicated=true;state.invalidHold=false;
    state.incomplete=false;state.failReadback=false;state.runStatus="draft";state.approvedAt=null;state.notes=null;
    state.dbQueries.length=0;state.calls.length=0;state.committed=0;state.rolledBack=0;state.updates=0;state.checkout=0;
  });
  afterEach(()=>vi.unstubAllEnvs());
  const post=(expectedDigest=digest)=>fetch(root+"/api/payroll/runs/32/super-admin-approve?companyId=9",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({confirm:true,expectedDigest,note:"Approved after item and kasbon review"}),
  });
  it("is fail-closed by default without connection or any writes",async()=>{
    const res=await post();expect(res.status).toBe(501);
    expect(state.checkout).toBe(0);expect(state.updates).toBe(0);
  });
  it("denies non-Super Admin roles even when feature flag is set",async()=>{
    vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","true");
    for(const role of ["owner","finance","staff","admin"]){
      state.role=role;expect((await post()).status).toBe(403);
    }
    expect(state.checkout).toBe(0);
  });
  it("preview requires signed server actor and detects invalid reservation",async()=>{
    state.role="super_admin";state.invalidHold=true;
    const res=await fetch(root+"/api/payroll/runs/32/super-admin-approval-preview");
    expect(res.status).toBe(200);
    const data=await res.json();
    expect(data.canApprove).toBe(false);
    expect(data.blockedReasons).toContain("KASBON_RESERVATIONS_INVALID");
    expect(data.readyForPayment).toBe(false);
    expect(state.updates).toBe(0);
  });
  it("rejects changed digest atomically without UPDATE or COMMIT",async()=>{
    vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","true");
    const res=await post("f".repeat(64));expect(res.status).toBe(409);
    expect(state.checkout).toBe(1);expect(state.rolledBack).toBe(1);
    expect(state.updates).toBe(0);expect(state.committed).toBe(0);
  });
  it("allows one Super Admin stage only after scoped checks, without journal or salary payment",async()=>{
    vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","true");
    const res=await post();expect(res.status).toBe(200);
    const result=await res.json();
    expect(result).toMatchObject({
      companyId:1,runId:32,status:"reviewed",oneSuperAdminApproval:true,
      hrReviewRequired:false,accountingReviewRequired:false,
      readyForPayment:false,accountingPosted:false,paid:false,
    });
    expect(state.committed).toBe(1);expect(state.updates).toBe(1);
    expect(state.calls.indexOf("SET_SCOPE_1")).toBeGreaterThan(state.calls.indexOf("BEGIN ISOLATION LEVEL READ COMMITTED"));
    expect(state.dbQueries.some(q=>q.sql.includes("FOR UPDATE"))).toBe(true);
    expect(state.dbQueries.some(q=>q.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(state.dbQueries.every(q=>! /\b(INSERT|DELETE|TRUNCATE|DROP|ALTER)\b/i.test(q.sql))).toBe(true);
    expect(state.dbQueries.filter(q=>/^\s*UPDATE\s+public\.payroll_runs\b/i.test(q.sql))).toHaveLength(1);
    expect((await post()).status).toBe(409);
    expect(state.updates).toBe(1);expect(state.committed).toBe(1);
  });
  it("rolls back if approval persistence readback fails",async()=>{
    vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","true");
    state.failReadback=true;
    const res=await post();expect(res.status).toBe(503);
    expect(state.rolledBack).toBe(1);expect(state.committed).toBe(0);
  });
  it("rejects incomplete employee coverage before any UPDATE",async()=>{
    vi.stubEnv("PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED","true");
    state.incomplete=true;
    const res=await post();expect(res.status).toBe(409);
    expect(state.rolledBack).toBe(1);expect(state.updates).toBe(0);
  });
});
