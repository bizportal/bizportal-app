import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state=vi.hoisted(()=>({
  role:"super_admin", companyId:null as number|null, dedicated:true,
  exists:true, runStatus:"draft", items:true, corrupt:false, calls:[] as string[],
}));
vi.mock("./dev-auth",()=>({
 isDevelopmentEnvironment:()=>true,
 getDevSession:()=>({id:"synthetic",email:"admin@example.test",role:state.role,companyId:state.companyId}),
 getProductionSession:()=>null,getProductionUser:async()=>null,
}));
vi.mock("./payroll-db",()=>({
 payrollDedicatedEnabled:()=>state.dedicated,
 payrollScopedQuery:async (_company:number,sql:string,_args:unknown[])=>{
  state.calls.push(sql);
  if(sql.includes("FROM public.payroll_runs WHERE"))return state.exists?
   {rowCount:1,rows:[{id:32,status:state.runStatus}]}:{rowCount:0,rows:[]};
  if(!state.items)return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[{
    id:11,employeeId:101,baseSalary:"5000000.00",allowance:"200000.00",
    grossSalary:"5200000.00",bpjsJhtEmployee:"100000.00",bpjsKesEmployee:"50000.00",
    pph21:"50000.00",otherDeductions:"0.00",kasbonDeduction:"100000.00",
    totalDeductions:"300000.00",netSalary:state.corrupt?"4900001.00":"4900000.00",
  }]};
 },
 getPayrollPool:()=>{throw Error("NO_WRITER");},
 setPayrollCompanyScope:async()=>{throw Error("NO_WRITER");},
}));
vi.mock("@workspace/db",()=>({pool:{
 connect:async()=>{throw Error("SHARED_POOL_FORBIDDEN");},
 query:async()=>{throw Error("SHARED_POOL_FORBIDDEN");},
}}));
describe("DEV calculation-preview: restricted pure payroll arithmetic",()=>{
 let server:Server,root:string;
 beforeAll(async()=>{
  const {default:router}=await import("./payroll");
  const app=express();app.use(express.json());app.use("/api",router);
  server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();if(!address||typeof address==="string")throw Error("PORT_MISSING");
  root=`http://127.0.0.1:${address.port}/api/payroll/runs/32/calculation-preview?companyId=1`;
 });
 afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
 beforeEach(()=>{
  Object.assign(state,{role:"super_admin",companyId:null,dedicated:true,
    exists:true,runStatus:"draft",items:true,corrupt:false});
  state.calls.length=0;delete process.env.PAYROLL_DEV_CALC_PREVIEW_ENABLED;
 });
 afterEach(()=>{delete process.env.PAYROLL_DEV_CALC_PREVIEW_ENABLED;});
 const get=(url=root)=>fetch(url);
 it("is default OFF without consulting any DB",async()=>{
  expect((await get()).status).toBe(404);expect(state.calls).toHaveLength(0);
 });
 it("requires dedicated Payroll read connection and does not fall back",async()=>{
  process.env.PAYROLL_DEV_CALC_PREVIEW_ENABLED="true";state.dedicated=false;
  expect((await get()).status).toBe(503);expect(state.calls).toHaveLength(0);
 });
 it("restricts company and does not expose salary to finance",async()=>{
  process.env.PAYROLL_DEV_CALC_PREVIEW_ENABLED="true";state.role="finance";state.companyId=1;
  expect((await get()).status).toBe(403);
  state.role="admin";state.companyId=1;expect((await get()).status).toBe(403);
  state.role="super_admin";state.companyId=null;
  expect((await get(root.replace("companyId=1","companyId=all"))).status).toBe(403);
  expect(state.calls).toHaveLength(0);
 });
 it("reuses saved amounts with integer cents and never writes data",async()=>{
  process.env.PAYROLL_DEV_CALC_PREVIEW_ENABLED="true";
  const response=await get();expect(response.status).toBe(200);
  const result=await response.json();
  expect(result).toMatchObject({companyId:1,runId:32,readOnly:true,canCalculate:false,
   canApprove:false,canPostJournal:false,canPay:false, gross:"5200000.00",
   deductions:"300000.00",net:"4900000.00",mismatchedItemIds:[]});
  expect(state.calls).toHaveLength(2);
  expect(state.calls.every(s=>s.trim().startsWith("SELECT"))).toBe(true);
 });
 it("shows stale item totals without repairing or posting",async()=>{
  process.env.PAYROLL_DEV_CALC_PREVIEW_ENABLED="true";state.corrupt=true;
  const response=await get();expect(response.status).toBe(200);
  expect(((await response.json()) as {mismatchedItemIds:number[]}).mismatchedItemIds).toEqual([11]);
  expect(state.calls.every(s=>s.trim().startsWith("SELECT"))).toBe(true);
 });
 it("refuses missing run, invalid state and incomplete roster",async()=>{
  process.env.PAYROLL_DEV_CALC_PREVIEW_ENABLED="true";state.exists=false;
  expect((await get()).status).toBe(404);state.exists=true;
  state.runStatus="paid";expect((await get()).status).toBe(409);
  state.runStatus="draft";state.items=false;expect((await get()).status).toBe(409);
 });
});
