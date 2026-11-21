import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const state=vi.hoisted(()=>({
  dev:true,signed:true,role:"super_admin",companyId:null as null|number,queryCount:0,
}));
vi.mock("../routes/dev-auth",()=>({
  isDevelopmentEnvironment:()=>state.dev,
  isSignedOtpDevEnabled:()=>state.signed,
  getDevSession:()=>state.signed?null:{id:"legacy-dev",email:"legacy@example.test",role:"admin",companyId:null},
  getProductionSession:()=>({id:"signed-id",email:"owner@example.test"}),
  getProductionUser:async()=>({id:"signed-id",email:"owner@example.test",role:state.role,companyId:state.companyId}),
}));
vi.mock("@workspace/db",()=>({
  pool:{query:async(sql:string)=>{
    state.queryCount++;
    if(sql.includes("public.accounting_settings s"))return {rows:[{
      id:3,company_name:"PT Diva Servis",company_address:null,company_npwp:null,company_logo_url:null,
      updated_at:"2026-11-21T00:00:00.000Z",
    }]};
    if(sql.includes("public.chart_of_accounts")||sql.includes("public.accounting_journals")||
       sql.includes("public.accounting_taxes"))return {rows:[]};
    throw Error("Unknown test query");
  }},
}));
import router from "../routes/accounting";
let server:Server,base:string;
beforeEach(async()=>{
  state.dev=true;state.signed=true;state.role="super_admin";state.companyId=null;state.queryCount=0;
  const app=express();
  app.use(express.json());
  app.use((req,_res,next)=>{(req as any).log={error:()=>{}};next();});
  app.use("/api",router);
  server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
  const address=server.address();
  if(!address||typeof address==="string")throw Error("No test port");
  base="http://127.0.0.1:"+address.port;
});
afterEach(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
async function call(path:string,method="GET"){
  const response=await fetch(base+"/api/accounting/"+path+"?company=3",{method});
  return {status:response.status,body:await response.json()};
}
describe("Accounting Settings DEV signed-OTP Super Admin",()=>{
  it("allows exact four GET-only resources and reads Company3 settings",async()=>{
    const a=await call("settings");
    expect(a.status).toBe(200);expect(a.body.companyName).toBe("PT Diva Servis");
    for(const p of ["accounts","journals","taxes"])expect((await call(p)).status).toBe(200);
    expect(state.queryCount).toBe(4);
  });
  it("rejects signed Super Admin mutations and other finance routes",async()=>{
    expect((await call("settings","PATCH")).status).toBe(403);
    expect((await call("accounts","POST")).status).toBe(403);
    expect((await call("reports/trial-balance")).status).toBe(403);
    expect(state.queryCount).toBe(0);
  });
  it("does not widen PROD Super Admin accounting permissions",async()=>{
    state.dev=false;state.signed=false;
    expect((await call("settings")).status).toBe(403);
  });
  it("rejects unrelated signed DEV roles",async()=>{
    state.role="logistics";
    expect((await call("settings")).status).toBe(403);
  });
  it("preserves the existing legacy DEV admin path",async()=>{
    state.signed=false;
    expect((await call("settings")).status).toBe(200);
  });
});
