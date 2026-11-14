import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { registerPayrollProdConnectionPreflightRoutes } from "./payroll-prod-connection-preflight";

const state=vi.hoisted(()=>({
  role:"finance", email:"finance@example.invalid",companyId:1,actorCompanyId:1 as number|null,
  ready:false,shared:true,ownerActive:false,throwError:false,
  scopedCalls:[] as Array<{companyId:number;sql:string;args:unknown[]}>,
  ownerQueries:0,
}));
vi.mock("@workspace/db",()=>({
  pool:{
    query:async()=>{
      state.ownerQueries++;
      return {rowCount:state.ownerActive?1:0,rows:state.ownerActive?[{ok:1}]:[]};
    },
  },
}));
vi.mock("./payroll-prod-db",()=>({
  payrollReadOnlyReady:()=>state.ready,
  payrollProdSharedReadOnlyEnabled:()=>state.shared,
  payrollScopedQuery:async(companyId:number,sql:string,args:unknown[])=>{
    state.scopedCalls.push({companyId,sql,args});
    if(state.throwError)throw Error("postgresql://sensitive:password@private.example/secret");
    return {rowCount:1,rows:[{dbRole:"bizportal_payroll_prod",companyScope:String(companyId),visibleRuns:"0",visibleProfiles:"0"}]};
  },
}));
describe("legacy Payroll PROD connection-preflight parity (read-only)",()=>{
  let server:Server;let root:string;
  beforeAll(async()=>{
    const router=Router();
    router.use((req,_res,next)=>{
      const scoped=req as typeof req & {payrollCompanyId?:number;payrollActor?:{id:string;email:string;role:string;companyId:number|null}};
      scoped.payrollCompanyId=state.companyId;
      scoped.payrollActor={id:"signed-session-test",email:state.email,role:state.role,companyId:state.actorCompanyId};
      next();
    });
    registerPayrollProdConnectionPreflightRoutes(router);
    const app=express();app.use("/api",router);server=createServer(app);
    server.listen(0,"127.0.0.1");await once(server,"listening");
    const address=server.address();
    if(!address||typeof address==="string")throw Error("MISSING_HTTP_PORT");
    root="http://127.0.0.1:"+address.port;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","production");state.role="finance";state.email="finance@example.invalid";
    state.companyId=1;state.actorCompanyId=1;state.ready=false;state.shared=true;
    state.ownerActive=false;state.throwError=false;state.scopedCalls.length=0;state.ownerQueries=0;
  });
  afterEach(()=>vi.unstubAllEnvs());
  const get=()=>fetch(root+"/api/payroll/connection-preflight?companyId=99");
  it("is not available in DEV and never touches a database",async()=>{
    vi.stubEnv("APP_ENV","development");const res=await get();
    expect(res.status).toBe(404);expect(state.scopedCalls).toHaveLength(0);
  });
  it("denies finance/staff and invalid scoped company without querying the database",async()=>{
    for(const role of ["finance","staff","admin"]){state.role=role;expect((await get()).status).toBe(403);}
    state.role="super_admin";state.companyId=0;expect((await get()).status).toBe(403);
    expect(state.scopedCalls).toHaveLength(0);expect(state.ownerQueries).toBe(0);
  });
  it("does not accept an unverified owner account",async()=>{
    state.role="owner";state.email="admcst001@gmail.com";state.actorCompanyId=1;
    expect((await get()).status).toBe(403);
    expect(state.scopedCalls).toHaveLength(0);expect(state.ownerQueries).toBe(1);
  });
  it("blocks absent readonly connection configuration even for Super Admin",async()=>{
    state.role="super_admin";const res=await get();
    expect(res.status).toBe(503);const data=await res.json();
    expect(data).toMatchObject({ready:false,readOnly:true,dedicatedConnectionVerified:false});
    expect(state.scopedCalls).toHaveLength(0);
  });
  it("returns only verified scoped read-only capability flags to Super Admin",async()=>{
    state.role="super_admin";state.ready=true;
    const res=await get();expect(res.status).toBe(200);
    const payload=await res.json();
    expect(payload).toMatchObject({
      ready:true,readOnly:true,connectionMode:"BIZPORTAL_SHARED_ROLE_SCOPED_READ_ONLY",
      dedicatedConnectionVerified:false,sharedRoleScopedVerified:true,
      companyScopeVerified:true,roleVerified:true,canPay:false,canPostJournal:false,canApprove:false,canWriteKasbon:false,
    });
    expect(state.scopedCalls).toHaveLength(1);
    expect(state.scopedCalls[0].companyId).toBe(1);
    expect(state.scopedCalls[0].sql).toContain("public.payroll_runs");
    expect(state.scopedCalls[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
    expect(JSON.stringify(payload)).not.toMatch(/password|secret|visibleRuns|visibleProfiles/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("accepts designated, DB-verified CST owner for read-only readiness only",async()=>{
    state.role="owner";state.email="admcst001@gmail.com";state.ownerActive=true;state.ready=true;
    expect((await get()).status).toBe(200);
    expect(state.ownerQueries).toBe(1);
    expect(state.scopedCalls).toHaveLength(1);
  });
  it("redacts raw DB errors and does not claim readiness",async()=>{
    state.role="super_admin";state.ready=true;state.throwError=true;
    const res=await get();expect(res.status).toBe(503);
    const body=await res.text();
    expect(body).not.toContain("postgresql://");
    expect(body).not.toContain("password");
    expect(body).toContain("PAYROLL_PROD_DATABASE_READINESS_FAILED");
  });
});
