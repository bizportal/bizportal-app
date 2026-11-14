import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state=vi.hoisted(()=>({
  enabled:true, session:true, actor:true, active:true, role:"owner",
  companyId:1 as number|null, userId:"google_103728868378401731050",
  dbRole:"owner", dbCompanyId:1, readerError:false, precheckError:false,
  storageReady:true, storageCalls:0,
  dbQueries:[] as Array<{sql:string; values:unknown[]}>,
  scoped:[] as Array<{companyId:number; sql:string; values:unknown[]}>,
}));
vi.mock("./dev-auth",()=>({
  getProductionSession:()=>state.session?{id:"session-test"}:null,
  getProductionUser:async()=>state.actor?{
    id:"mock",email:"approved-owner@example.test",
    role:state.role,companyId:state.companyId,
  }:null,
}));
vi.mock("@workspace/db",()=>({
  pool:{query:async(sql:string,values:unknown[])=>{
    state.dbQueries.push({sql,values});
    if(!state.active)return{rowCount:0,rows:[]};
    return{rowCount:1,rows:[{
      db_user_id:state.userId,db_company_id:state.dbCompanyId,db_role:state.dbRole,
    }]};
  }},
}));
vi.mock("./hrd-readonly-db",()=>({
  withHrdCompanyReadOnly:async(companyId:number,fn:(client:any)=>Promise<unknown>)=>{
    if(state.readerError)throw Error("secret-password-not-for-response");
    return fn({query:async(sql:string,values:unknown[])=>{
      state.scoped.push({companyId,sql,values});
      if(sql.includes("employee_resign_kasbon_precheck(")){
        if(state.precheckError)throw Error("SENSITIVE_PREFLIGHT_DB_ERROR");
        return{rowCount:1,rows:[{
          unverifiedCount:"2",unverifiedAmount:"16000000.00",
          verifiedUnsettledCount:"0",verifiedUnsettledAmount:"0.00",
          activeReservations:"0",activeReservationAmount:"0.00",
        }]};
      }
      if(sql.includes("SELECT id FROM"))return{rowCount:1,rows:[{id:38}]};
      const rows=companyId===1?[{
        id:38,company_id:1,first_name:"Andi",last_name:"Wangsamas",
        status:"active",email:null,phone:null,position:"Staff",hire_date:null,
      }]:[];
      return{rowCount:rows.length,rows};
    }});
  },
}));
vi.mock("./hrd-storage-readiness",()=>({
  hrdStorageMetadataPreflightEnabled:()=>process.env.APP_ENV==="production" &&
    process.env.HRD_CANONICAL_READONLY_ENABLED==="true" &&
    process.env.HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED==="true",
  probeHrdPrivateStorageMetadata:async()=>{state.storageCalls++;return state.storageReady;},
}));
import router from "./hrd-routes";

describe("canonical gated HRD directory stage-one",()=>{
  let server:Server,base:string;
  beforeAll(async()=>{
    const app=express();app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const addr=server.address();if(!addr||typeof addr==="string")throw Error("missing-port");
    base="http://127.0.0.1:"+addr.port;
  });
  afterAll(async()=>await new Promise<void>(resolve=>server.close(()=>resolve())));
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("HRD_CANONICAL_READONLY_ENABLED","true");
    vi.stubEnv("HRD_CANONICAL_RESIGN_PREFLIGHT_ENABLED","");
    vi.stubEnv("HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED","");
    state.enabled=true;state.session=true;state.actor=true;state.active=true;
    state.role="owner";state.companyId=1;state.dbRole="owner";state.dbCompanyId=1;
    state.userId="google_103728868378401731050";state.readerError=false;state.precheckError=false;
    state.dbQueries.length=0;state.scoped.length=0;state.storageCalls=0;state.storageReady=true;
  });
  afterEach(()=>vi.unstubAllEnvs());
  const get=(path="/hrd/employees?companyId=1")=>fetch(base+"/api"+path);
  it("remains disabled by default or outside production with zero DB reads",async()=>{
    vi.stubEnv("HRD_CANONICAL_READONLY_ENABLED","");
    expect((await get()).status).toBe(404);
    vi.stubEnv("HRD_CANONICAL_READONLY_ENABLED","true");
    vi.stubEnv("APP_ENV","development");
    expect((await get()).status).toBe(404);
    expect(state.dbQueries).toHaveLength(0);
    expect(state.scoped).toHaveLength(0);
  });
  it("requires valid production session, active account and DB-matching role",async()=>{
    state.session=false;expect((await get()).status).toBe(401);
    state.session=true;state.actor=false;expect((await get()).status).toBe(403);
    state.actor=true;state.active=false;expect((await get()).status).toBe(403);
    state.active=true;state.dbRole="staff";expect((await get()).status).toBe(403);
    expect(state.scoped).toHaveLength(0);
  });
  it("permits only the designated CST owner for company 1",async()=>{
    const r=await get();expect(r.status).toBe(200);
    const data=await r.json() as Record<string,any>;
    expect(data).toMatchObject({companyId:1,readOnly:true,statusChangeEnabled:false,
      documentUploadEnabled:false,ocrEnabled:false,canPay:false,
      coverage:"HRD_DIRECTORY_STAGE1"});
    expect(data.employees).toHaveLength(1);
    expect(data.employees[0].id).toBe(38);
    expect(state.scoped).toHaveLength(1);
    expect(state.scoped[0].companyId).toBe(1);
    expect(state.scoped[0].values).toEqual([1]);
    expect(state.scoped[0].sql).toContain("deleted_at IS NULL");
  });
  it("rejects generic owner and cross-company queries",async()=>{
    state.userId="generic-owner";
    expect((await get()).status).toBe(403);
    state.userId="google_103728868378401731050";
    expect((await get("/hrd/employees?companyId=2")).status).toBe(403);
    expect((await get("/hrd/employees")).status).toBe(403);
    expect(state.scoped).toHaveLength(0);
  });
  it("super_admin receives only explicitly scoped company rows",async()=>{
    state.role="super_admin";state.dbRole="super_admin";state.companyId=null;
    const r=await get("/hrd/employees?companyId=2");
    expect(r.status).toBe(200);
    const data=await r.json() as Record<string,any>;
    expect(data.companyId).toBe(2);expect(data.employees).toEqual([]);
    expect(state.scoped[0].values).toEqual([2]);
  });
  it("readiness checks same scoped reader and never returns employee details",async()=>{
    const r=await get("/hrd/readiness?companyId=1");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ready:true,companyId:1,readOnly:true});
    expect(state.scoped[0].sql).toContain("SELECT id");
  });
  it("does not register any write or private-document route",async()=>{
    const response=await fetch(base+"/api/hrd/employees/38/status?companyId=1",{
      method:"POST",headers:{"Content-Type":"application/json"},body:"{}",
    });
    expect([404,405]).toContain(response.status);
    expect((await get("/hrd/employees/38?companyId=1")).status).toBe(404);
    expect(state.scoped).toHaveLength(0);
  });
  it("redacts DB reader errors and does not turn failure into empty employee list",async()=>{
    state.readerError=true;
    const response=await get();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-password-not-for-response");
  });
  it("resign precheck stays dormant without separate release flag",async()=>{
    const r=await get("/hrd/employees/38/resign-kasbon-precheck?companyId=1");
    expect(r.status).toBe(404);
    expect(state.scoped).toHaveLength(0);
  });
  it("returns historical unverified kasbon without allowing resign or payroll write",async()=>{
    vi.stubEnv("HRD_CANONICAL_RESIGN_PREFLIGHT_ENABLED","true");
    const r=await get("/hrd/employees/38/resign-kasbon-precheck?companyId=1");
    expect(r.status).toBe(200);
    const data=await r.json() as Record<string,any>;
    expect(data).toMatchObject({
      companyId:1,employeeId:38,employeeStatus:"active",
      unverifiedCount:2,unverifiedAmount:"16000000.00",
      verifiedUnsettledCount:0,activeReservations:0,
      hasUnresolved:true,canDeactivate:false,
      checkReadOnly:true,kasbonUnchanged:true,canPay:false,
      canPostJournal:false,canChangeStatus:false,
    });
    expect(state.scoped).toHaveLength(2);
    expect(state.scoped[0].values).toEqual([38,1]);
    expect(state.scoped[1].values).toEqual([1,38]);
    expect(state.scoped.every(x=>x.companyId===1)).toBe(true);
    expect(state.scoped.some(x=>/\b(UPDATE|DELETE|INSERT)\b/i.test(x.sql))).toBe(false);
  });
  it("rejects malformed ID, company mismatch and unapproved owner with no HRD data read",async()=>{
    vi.stubEnv("HRD_CANONICAL_RESIGN_PREFLIGHT_ENABLED","true");
    expect((await get("/hrd/employees/0/resign-kasbon-precheck?companyId=1")).status).toBe(400);
    expect((await get("/hrd/employees/38/resign-kasbon-precheck?companyId=2")).status).toBe(403);
    state.userId="generic-owner";
    expect((await get("/hrd/employees/38/resign-kasbon-precheck?companyId=1")).status).toBe(403);
    expect(state.scoped).toHaveLength(0);
  });
  it("returns no sensitive DB details when resign precheck is unavailable",async()=>{
    vi.stubEnv("HRD_CANONICAL_RESIGN_PREFLIGHT_ENABLED","true");
    state.precheckError=true;
    const r=await get("/hrd/employees/38/resign-kasbon-precheck?companyId=1");
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("SENSITIVE_PREFLIGHT_DB_ERROR");
  });

  it("keeps private storage metadata preflight disabled by default",async()=>{
    const r=await get("/hrd/storage-readiness?companyId=1");
    expect(r.status).toBe(404);
    expect(state.storageCalls).toBe(0);
    expect(state.scoped).toHaveLength(0);
  });
  it("requires verified active HRD account and company before storage metadata probe",async()=>{
    vi.stubEnv("HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED","true");
    state.session=false;
    expect((await get("/hrd/storage-readiness?companyId=1")).status).toBe(401);
    state.session=true;state.active=false;
    expect((await get("/hrd/storage-readiness?companyId=1")).status).toBe(403);
    state.active=true;state.userId="wrong-owner";
    expect((await get("/hrd/storage-readiness?companyId=1")).status).toBe(403);
    state.userId="google_103728868378401731050";
    expect((await get("/hrd/storage-readiness?companyId=2")).status).toBe(403);
    expect(state.storageCalls).toBe(0);
  });
  it("returns safe private bucket readiness only and never exposes credentials or employee records",async()=>{
    vi.stubEnv("HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED","true");
    const r=await get("/hrd/storage-readiness?companyId=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({
      companyId:1,ready:true,storagePrivate:true,readOnly:true,
      uploadEnabled:false,ocrEnabled:false,coverage:"HRD_STORAGE_METADATA_ONLY",
    });
    expect(state.storageCalls).toBe(1);
    expect(state.scoped).toHaveLength(0);
  });
  it("returns 503 without secrets when private bucket metadata is invalid",async()=>{
    vi.stubEnv("HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED","true");
    state.storageReady=false;
    const r=await get("/hrd/storage-readiness?companyId=1");
    expect(r.status).toBe(503);
    const t=await r.text();
    expect(t).toContain('"ready":false');
    expect(t).not.toMatch(/secret|password|credential|storage_path|signed_url/i);
  });
  it("never mounts storage upload, OCR or write actions",async()=>{
    vi.stubEnv("HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED","true");
    const r=await fetch(base+"/api/hrd/storage-readiness?companyId=1",{method:"POST"});
    expect([404,405]).toContain(r.status);
    const document=await fetch(base+"/api/hrd/employees/38/documents/prepare?companyId=1",{method:"POST"});
    expect([404,405]).toContain(document.status);
    expect(state.storageCalls).toBe(0);
  });

});
