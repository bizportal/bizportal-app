import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";

const state=vi.hoisted(()=>({environment:"development",actor:null as null|{id:string;email:string;role:string;companyId:number|null},
  sql:[] as Array<{sql:string;args:unknown[]}>,runStatus:"draft",released:0,fail:false,shared:0,pendingKasbon:false}));
vi.mock("./dev-auth",()=>({isDevelopmentEnvironment:()=>state.environment==="development",
  getProductionSession:()=>null,getProductionUser:async()=>null,getDevSession:()=>state.actor}));
vi.mock("@workspace/db",()=>({
  pool:{query:async()=>{state.shared++;throw Error("SHARED_POOL_FORBIDDEN");},connect:async()=>{state.shared++;throw Error("SHARED_POOL_FORBIDDEN");}},
  createDedicatedPayrollPool:()=>({end:async()=>{},connect:async()=>({
    release:()=>{state.released++;},
    query:async(sql:string,args:unknown[]=[])=>{
      state.sql.push({sql,args});
      const rows=(rows:unknown[])=>({rows,rowCount:rows.length});
      if(sql.startsWith("BEGIN")||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config"))return rows([]);
      if(sql.includes("FROM public.payroll_runs"))return rows(args[0]===1&&args[1]===8?[{id:8,month:11,year:2026,status:state.runStatus}]:[]);
      if(state.fail)throw Error("SYNTHETIC_READ_ERROR");
      if(sql.includes("FROM public.payroll_salary_profiles"))return rows([{employeeId:21,firstName:"QA",lastName:"Employee",baseSalary:"5000000",allowance:"1000000",salaryEffectiveFrom:"2026-11-01"}]);
      if(sql.includes("FROM public.payroll_deduction_settings"))return rows(["bpjs_jht_employee","bpjs_kes_employee","pph21","other_deductions","kasbon_deduction"].map(code=>({employeeId:21,code,amount:"0",effectiveFrom:"2026-11-01",notes:null})));
      if(sql.includes("FROM public.cash_advances"))return rows(state.pendingKasbon?[{
        id:23,companyId:1,employeeId:21,type:"kasbon",status:"active",lifecycleStatus:"approved",
        currency:"IDR",amount:"500000.00",paidAmount:"0.00",settledAmount:"0.00",
        remainingAmount:"500000.00",approvedAt:"2026-11-20",approvedBy:"fixture-owner",
        disbursedAt:null,disbursedBy:null,accountingEntryId:null,postingStatus:"PENDING",voidedAt:null,
      }]:[]);
      if(sql.includes("FROM public.payroll_kasbon_auto_plans"))return rows(state.pendingKasbon?[{
        companyId:1,employeeId:21,advanceId:23,choice:"FULL",installmentAmount:null,
        firstPeriod:"2026-11-01",updatedAt:"2026-11-20",
      }]:[]);
      if(sql.includes("FROM public.payroll_kasbon_auto_reservations"))return rows([]);
      throw Error("UNEXPECTED_QUERY");
    },
  })}),
}));

describe("Payroll effective setup GET behind canonical authorization",()=>{
  let server:Server,root:string;
  const actor={id:"qa",email:"qa@example.invalid",role:"super_admin",companyId:null};
  const get=(run=8,scope=1)=>fetch(root+"/payroll/runs/"+run+"/setup-preview?companyId="+scope);
  beforeAll(async()=>{
    const {default:router}=await import("./payroll");
    const app=express();app.use(express.json());app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const address=server.address();if(!address||typeof address==="string")throw Error("NO_HTTP_LISTENER");
    root="http://127.0.0.1:"+address.port+"/api";
  });
  beforeEach(()=>{
    state.environment="development";state.actor=actor;state.sql=[];state.released=0;state.runStatus="draft";state.fail=false;state.shared=0;state.pendingKasbon=false;
    vi.stubEnv("APP_ENV","development");
    vi.stubEnv("PAYROLL_DATABASE_URL_DEV","postgresql://bizportal_payroll_dev.xssrfshdrtdfupgqwfdw:ci_only@127.0.0.1:65432/payroll_ci");
  });
  afterEach(async()=>{const {closeDedicatedPayrollPool}=await import("./payroll-db");await closeDedicatedPayrollPool();vi.unstubAllEnvs();});
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
  it("requires a session and valid assigned company before any DB access",async()=>{
    state.actor=null;expect((await get()).status).toBe(401);
    state.actor={...actor,role:"admin",companyId:1};expect((await get(8,2)).status).toBe(403);
    expect(state.sql).toHaveLength(0);expect(state.shared).toBe(0);
  });
  it("disallows unauthorized roles and PROD, no shared connection fallback",async()=>{
    state.actor={...actor,role:"finance",companyId:1};expect((await get()).status).toBe(403);
    state.actor=actor;vi.stubEnv("PAYROLL_DATABASE_URL_DEV","");expect((await get()).status).toBe(503);
    state.environment="production";vi.stubEnv("APP_ENV","production");expect((await get()).status).toBe(401);
    expect(state.sql).toHaveLength(0);expect(state.shared).toBe(0);
  });
  it("exposes an explicitly read-only DEV capability and GET projection in one scoped snapshot",async()=>{
    const cap=await fetch(root+"/payroll/capabilities?companyId=1");expect(await cap.json()).toMatchObject({canPreviewSetup:true,canCalculate:false,canApprove:false,canPay:false});
    const res=await get();expect(res.status).toBe(200);expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({companyId:1,runId:8,month:11,year:2026,readOnly:true,persisted:false,canMaterialize:false,readyForPayment:false,rows:[{employeeId:21,net:"6000000.00",issues:[]}]});
    expect(state.sql[0].sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(state.sql[1].args).toEqual(["1"]);
    expect(state.sql.slice(2,-1).every(x=>x.sql.startsWith("SELECT")&&x.args[0]===1)).toBe(true);
    expect(state.sql.at(-1)?.sql).toBe("COMMIT");expect(state.released).toBe(1);expect(state.shared).toBe(0);
  });
  it("never deducts approved but undisbursed kasbon even with a FULL payroll plan",async()=>{
    state.pendingKasbon=true;
    const res=await get();expect(res.status).toBe(200);
    const preview=await res.json();
    expect(preview).toMatchObject({readOnly:true,persisted:false,canMaterialize:false,readyForPayment:false});
    expect(preview).toMatchObject({rows:[{
      deductions:{kasbon_deduction:"0.00"},
      net:null,
      issues:expect.arrayContaining(["KASBON_PLAN_SOURCE_NOT_ELIGIBLE"]),
    }]});
    expect(state.sql.filter(x=>/^\s*(insert|update|delete)\b/i.test(x.sql))).toHaveLength(0);
    expect(state.sql.at(-1)?.sql).toBe("COMMIT");
    expect(state.shared).toBe(0);
  });
  it("rejects missing and non-draft runs without reading employee salary",async()=>{
    expect((await get(99)).status).toBe(404);
    state.runStatus="approved";expect((await get()).status).toBe(409);
    expect(state.sql.filter(x=>x.sql.includes("FROM public.employees"))).toHaveLength(0);
  });
  it("rolls back on read failure and never enables Calculate or payment",async()=>{
    state.fail=true;expect((await get()).status).toBe(503);
    expect(state.sql.at(-1)?.sql).toBe("ROLLBACK");expect(state.released).toBe(1);
    expect((await fetch(root+"/payroll/runs/8/calculate?companyId=1",{method:"POST"})).status).toBe(501);
    expect(state.shared).toBe(0);
  });
});
