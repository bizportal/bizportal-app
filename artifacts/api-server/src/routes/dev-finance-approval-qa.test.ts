import {beforeAll,afterAll,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import type {Server} from "node:http";
import type {AddressInfo} from "node:net";
import pg from "pg";
const fake=vi.hoisted(()=>({session:vi.fn(),user:vi.fn(),scope:vi.fn(),dev:vi.fn(),global:vi.fn(),company:vi.fn()}));
vi.mock("./dev-auth",()=>({
 getProductionSession:fake.session,getProductionUser:fake.user,
 getFinanceCompanyScope:fake.scope,isApprovedFinanceGlobalSuperAdmin:fake.global,
 isApprovedFinanceGlobalCompany:fake.company,isDevelopmentEnvironment:fake.dev,
}));
import qa from "./dev-finance-approval-qa";
let server:Server,base:string,admin:pg.Client;
const url="postgres://postgres@127.0.0.1:55495/finance_approval_qa";
beforeAll(async()=>{
 const app=express();app.use(express.json());app.use("/api",qa);
 server=app.listen(0,"127.0.0.1");
 await new Promise<void>(r=>server.once("listening",r));
 base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
 admin=new pg.Client({connectionString:url});await admin.connect();
});
afterAll(async()=>{
 await admin?.end();await new Promise<void>(r=>server.close(()=>r()));
});
beforeEach(async()=>{
 process.env.APP_ENV="development";
 process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV="true";
 process.env.BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL=url;
 fake.dev.mockReturnValue(true);
 fake.session.mockReturnValue({id:"signed-session"});
 fake.user.mockResolvedValue({email:"owner@example.invalid",role:"super_admin",companyId:1});
 fake.global.mockReturnValue(false);fake.company.mockReturnValue(true);fake.scope.mockReturnValue(null);
 await admin.query("update public.qa_approval_scenarios set status='pending',approved_at=null,approved_by=null");
 await admin.query("truncate public.qa_approval_audit restart identity");
});
function post(id=9001,extra:Record<string,string>={}){
 const u=new URL(base);
 return fetch(base+"/api/mkt/admin/payment-approval-qa",{method:"POST",
  headers:{"Content-Type":"application/json","Origin":"https://"+u.host,
    "Sec-Fetch-Site":"same-origin",...extra},
  body:JSON.stringify({scenarioId:id})});
}
describe("signed Super Admin real HTTP to isolated QA approval",()=>{
 it("shows actionable synthetic scenario then writes exactly once",async()=>{
  const list=await fetch(base+"/api/mkt/admin/payment-approval-qa");
  expect(list.status).toBe(200);
  const before=await list.json();
  expect(before).toMatchObject({sandbox:true,bankTransfer:false,glPosted:false,scenario:{id:9001,status:"pending"}});
  const p=await post();expect(p.status).toBe(200);
  expect(await p.json()).toMatchObject({ok:true,status:"approved",replay:false,sandbox:true,glPosted:false});
  const replay=await post();expect(await replay.json()).toMatchObject({ok:true,replay:true});
  const a=await admin.query("select count(*)::int as n from public.qa_approval_audit where scenario_id=9001");
  expect(a.rows[0].n).toBe(1);
 });
 it("rejects anonymous and wrong role or company",async()=>{
  fake.session.mockReturnValue(null);expect((await post()).status).toBe(401);
  fake.session.mockReturnValue({id:"signed"});
  fake.user.mockResolvedValue({email:"user@example.invalid",role:"admin",companyId:1});
  expect((await post()).status).toBe(403);
  fake.user.mockResolvedValue({email:"owner@example.invalid",role:"super_admin",companyId:3});
  expect((await post(9001)).status).toBe(404);
 });
 it("fails closed on cross-origin and non-JSON requests",async()=>{
  expect((await post(9001,{Origin:"https://evil.invalid"})).status).toBe(403);
  const bad=await fetch(base+"/api/mkt/admin/payment-approval-qa",{method:"POST",headers:{"Content-Type":"text/plain"},body:"9001"});
  expect(bad.status).toBe(403);
 });
 it("stays closed if flag off, production mode or DB URL not isolated",async()=>{
  process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV="false";
  expect((await fetch(base+"/api/mkt/admin/payment-approval-qa")).status).toBe(404);
  process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV="true";
  process.env.APP_ENV="production";
  expect((await fetch(base+"/api/mkt/admin/payment-approval-qa")).status).toBe(404);
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL="postgres://postgres@prod.example.invalid/db";
  expect((await fetch(base+"/api/mkt/admin/payment-approval-qa")).status).toBe(404);
 });
});
