import {beforeAll,afterAll,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import pg from "pg";
import type {Server} from "node:http";
import type {AddressInfo} from "node:net";
const fake=vi.hoisted(()=>({session:vi.fn(),user:vi.fn(),scope:vi.fn(),dev:vi.fn(),global:vi.fn(),company:vi.fn()}));
vi.mock("./dev-auth",()=>({
  getProductionSession:fake.session,getProductionUser:fake.user,
  getFinanceCompanyScope:fake.scope,isApprovedFinanceGlobalSuperAdmin:fake.global,
  isApprovedFinanceGlobalCompany:fake.company,isDevelopmentEnvironment:fake.dev,
}));
import route from "./dev-finance-po14-e2e-qa";
let server:Server,base:string,db:pg.Client;
beforeAll(async()=>{
  const app=express();app.use(express.json());app.use("/api",route);
  server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  db=new pg.Client({connectionString:"postgres://postgres@127.0.0.1:55495/finance_approval_qa"});
  await db.connect();
});
afterAll(async()=>{await db?.end();await new Promise<void>(r=>server.close(()=>r()));});
beforeEach(async()=>{
  fake.dev.mockReturnValue(true);
  fake.session.mockReturnValue({id:"signed"});
  fake.user.mockResolvedValue({email:"owner@qa.invalid",role:"super_admin",companyId:1});
  fake.global.mockReturnValue(false);fake.company.mockReturnValue(true);fake.scope.mockReturnValue(null);
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV="true";
  process.env.BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL="postgres://postgres@127.0.0.1:55495/finance_approval_qa";
  await db.query("truncate public.qa_po14_e2e_audit,public.qa_po14_e2e_runs restart identity cascade");
});
const path="/api/mkt/admin/po14-e2e-qa";
function post(origin?:string){
  return fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",
    "Origin":origin??"https://"+new URL(base).host,"Sec-Fetch-Site":"same-origin"},
    body:JSON.stringify({reference:"PO-20261117-00014"})});
}
describe("signed PO14 E2E simulation QA HTTP, isolated database",()=>{
 it("records one immutable seven-stage simulated receipt and audit; replay is idempotent",async()=>{
   const first=await post();expect(first.status).toBe(200);
   const data=await first.json() as any;
   expect(data).toMatchObject({sandbox:true,bankTransfer:false,businessLedgerPosted:false,
     actualBankReconcilerExecuted:false,actualVendorInvoiceCreated:false,
     result:{reference:"PO-20261117-00014",status:"completed",amount:"100000.00",auditCount:1}});
   expect(data.result.steps).toHaveLength(7);
   expect(data.result.steps.every((step:any)=>step.status==="SIMULATED")).toBe(true);
   const replay=await post();expect(replay.status).toBe(200);
   const count=await db.query("select count(*)::int n from public.qa_po14_e2e_audit");
   expect(count.rows[0].n).toBe(1);
 });
 it("concurrent identical submissions create one QA receipt",async()=>{
   const results=await Promise.all([post(),post()]);
   expect(results.map(x=>x.status)).toEqual([200,200]);
   const rows=await db.query("select count(*)::int n from public.qa_po14_e2e_runs");
   expect(rows.rows[0].n).toBe(1);
 });
 it("refuses anonymous, non-Superadmin and Diva sessions",async()=>{
   fake.session.mockReturnValue(null);expect((await post()).status).toBe(401);
   fake.session.mockReturnValue({id:"signed"});
   fake.user.mockResolvedValue({email:"other@qa.invalid",role:"admin",companyId:1});
   expect((await post()).status).toBe(403);
   fake.user.mockResolvedValue({email:"other@qa.invalid",role:"super_admin",companyId:3});
   expect((await post()).status).toBe(403);
   const count=await db.query("select count(*)::int n from public.qa_po14_e2e_audit");
   expect(count.rows[0].n).toBe(0);
 });
 it("refuses cross-origin, unsupported body, and a second actor",async()=>{
   expect((await post("https://evil.invalid")).status).toBe(403);
   const wrong=await fetch(base+path,{method:"POST",
     headers:{"Origin":"https://"+new URL(base).host,"Content-Type":"application/json"},
     body:JSON.stringify({reference:"PO-99"})});
   expect(wrong.status).toBe(422);
   expect((await post()).status).toBe(200);
   fake.user.mockResolvedValue({email:"second@qa.invalid",role:"super_admin",companyId:1});
   expect((await post()).status).toBe(409);
 });
 it("fails closed in PROD, flag OFF and other database URL",async()=>{
   process.env.APP_ENV="production";
   expect((await post()).status).toBe(404);
   process.env.APP_ENV="development";
   process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV="false";
   expect((await post()).status).toBe(404);
   process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV="true";
   process.env.BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL="postgres://postgres@prod.invalid/db";
   expect((await post()).status).toBe(404);
 });
});
