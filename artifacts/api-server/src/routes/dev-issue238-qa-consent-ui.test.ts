import express from "express";
import {describe,it,expect,vi,beforeAll,afterAll,beforeEach,afterEach} from "vitest";
import type {Server} from "node:http";
const auth=vi.hoisted(()=>({session:vi.fn(),user:vi.fn(),enabled:vi.fn()}));
vi.mock("./dev-auth",()=>({
 getProductionSession:auth.session,
 getProductionUser:auth.user,
 isSignedOtpDevEnabled:auth.enabled,
}));
import route from "./dev-issue238-qa-consent-ui";
let server:Server,base:string;
const original={
 APP_ENV:process.env.APP_ENV,
 BIZPORTAL_ISSUE238_OWNER_OTP_DEV:process.env.BIZPORTAL_ISSUE238_OWNER_OTP_DEV,
};
describe("Owner QA #238 consent UI fail-closed",()=>{
 beforeAll(async()=>{
  const app=express();app.use("/api",route);
  server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const a=server.address();if(!a||typeof a==="string")throw Error("no port");
  base="http://127.0.0.1:"+a.port;
 });
 afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));});
 beforeEach(()=>{
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_ISSUE238_OWNER_OTP_DEV="true";
  auth.enabled.mockReturnValue(true);
  auth.session.mockImplementation(()=>({id:"cst-owner",email:"owner@example.invalid",
    issuedAt:Date.now()-1000,expiresAt:Date.now()+60000}));
  auth.user.mockResolvedValue({id:"cst-owner",email:"owner@example.invalid",
    role:"super_admin",companyId:1});
 });
 afterEach(()=>{
  vi.resetAllMocks();
  for(const [k,v] of Object.entries(original)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
 });
 const url=()=>base+"/api/auth/dev/issue238-qa/consent";
 it("404 feature disabled",async()=>{
  delete process.env.BIZPORTAL_ISSUE238_OWNER_OTP_DEV;
  const r=await fetch(url());expect(r.status).toBe(404);
 });
 it("401 when OTP missing",async()=>{
  auth.session.mockReturnValue(null);
  expect((await fetch(url())).status).toBe(401);
 });
 it("401 when role wrong or session stale",async()=>{
  auth.user.mockResolvedValue({id:"cst-owner",email:"owner@example.invalid",role:"admin",companyId:1});
  expect((await fetch(url())).status).toBe(401);
  auth.user.mockResolvedValue({id:"cst-owner",email:"owner@example.invalid",role:"super_admin",companyId:1});
  auth.session.mockReturnValue({id:"cst-owner",email:"owner@example.invalid",issuedAt:Date.now()-700000,expiresAt:Date.now()+60000});
  expect((await fetch(url())).status).toBe(401);
 });
 it("200 renders a real button with strict CSP and no auto dispatch",async()=>{
  const r=await fetch(url());expect(r.status).toBe(200);
  const html=await r.text();
  expect(html).toContain('id="approve"');
  expect(html).toContain("Setujui QA #238 DEV");
  expect(html).toContain("belum mengirim ke pelaksana");
  expect(html).toContain("credentials:\"same-origin\"");
  expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(r.headers.get("cache-control")).toBe("no-store");
 });
});
