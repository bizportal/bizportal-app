import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
type Actor={id:string;email:string;role:string;companyId:number|null};
const state=vi.hoisted(()=>({dev:true,actor:null as Actor|null,dbCalls:0}));
vi.mock("./dev-auth",()=>({
  isDevelopmentEnvironment:()=>state.dev,
  getDevSession:()=>state.dev?state.actor:null,
  getProductionSession:()=>state.dev?null:state.actor,
  getProductionUser:async()=>state.actor,
}));
vi.mock("@workspace/db",()=>({
  pool:{
    connect:async()=>{state.dbCalls++;throw Error("RETIRED_GENERATE_MUST_NOT_CONNECT");},
    query:async()=>{state.dbCalls++;throw Error("RETIRED_GENERATE_MUST_NOT_QUERY");},
  },
  createDedicatedPayrollPool:()=>{state.dbCalls++;throw Error("RETIRED_GENERATE_MUST_NOT_CREATE_POOL");},
}));
describe("retired legacy Payroll master salary generation",()=>{
  let server:Server,root:string;
  beforeAll(async()=>{
    const {default:router}=await import("./payroll");
    const app=express();app.use(express.json());app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const address=server.address();if(!address||typeof address==="string")throw Error("NO_TEST_PORT");
    root="http://127.0.0.1:"+address.port+"/api/payroll";
  });
  afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
  beforeEach(()=>{
    state.dev=true;state.actor={id:"fixture",email:"qa@example.invalid",role:"super_admin",companyId:1};state.dbCalls=0;
    vi.stubEnv("APP_ENV","development");vi.stubEnv("PAYROLL_DEV_GENERATE_ENABLED","");
    vi.stubEnv("PAYROLL_DATABASE_URL_DEV","postgresql://bizportal_payroll_dev.xssrfshdrtdfupgqwfdw:fixture@127.0.0.1:65432/payroll_ci");
    vi.stubEnv("PAYROLL_DEV_COMPONENTS_ENABLED","true");
  });
  afterEach(()=>vi.unstubAllEnvs());
  const send=(company=1)=>fetch(root+"/runs/20/generate-items?companyId="+company,{method:"POST"});
  it.each(["","false","true"])("retains HTTP 410 and no SQL regardless of legacy flag %s",async flag=>{
    vi.stubEnv("PAYROLL_DEV_GENERATE_ENABLED",flag);
    const r=await send();expect(r.status).toBe(410);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({code:"PAYROLL_LEGACY_GENERATE_RETIRED"});
    const cap=await fetch(root+"/capabilities?companyId=1");
    expect(await cap.json()).toMatchObject({canGenerate:false,canPreviewSetup:true,canEditComponents:true,canCalculate:false,canApprove:false,canPay:false});
    expect(state.dbCalls).toBe(0);
  });
  it.each(["admin","owner","super_admin"])("never copies unverified salary for %s",async role=>{
    state.actor={...state.actor!,role};
    vi.stubEnv("PAYROLL_DEV_GENERATE_ENABLED","true");
    expect((await send()).status).toBe(410);expect(state.dbCalls).toBe(0);
  });
  it("rejects anonymous and unauthorized finance/accounting sessions before database access",async()=>{
    const actor=state.actor!;state.actor=null;expect((await send()).status).toBe(401);
    for(const role of ["finance","accounting"]){state.actor={...actor,role};expect((await send()).status).toBe(403);}
    state.actor={...actor,role:"admin",companyId:1};expect((await send(2)).status).toBe(403);
    expect(state.dbCalls).toBe(0);
  });
  it("preserves the closed PROD contract even if legacy flag is true",async()=>{
    state.dev=false;vi.stubEnv("APP_ENV","production");vi.stubEnv("PAYROLL_DEV_GENERATE_ENABLED","true");
    expect((await send()).status).toBe(501);
    expect(await (await fetch(root+"/capabilities?companyId=1")).json()).toMatchObject({canGenerate:false,canEditComponents:false,canCalculate:false,canApprove:false,canPay:false});
    expect(state.dbCalls).toBe(0);
  });
});
