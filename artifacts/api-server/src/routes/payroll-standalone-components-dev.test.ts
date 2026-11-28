import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import {once} from "node:events";
import {createServer} from "node:http";
const state=vi.hoisted(()=>({dev:true,role:"super_admin",sql:[] as {sql:string;args:unknown[]}[],shared:0,failWrite:false}));
vi.mock("./dev-auth",()=>({isDevelopmentEnvironment:()=>state.dev,getProductionSession:()=>null,getProductionUser:async()=>null,
  getDevSession:()=>state.role?{id:"qa",email:"qa@example.invalid",role:state.role,companyId:1}:null}));
vi.mock("@workspace/db",()=>({
  pool:{connect:async()=>{state.shared++;throw Error("SHARED_POOL_FORBIDDEN");},query:async()=>{state.shared++;throw Error("SHARED_POOL_FORBIDDEN");}},
  createDedicatedPayrollPool:()=>({end:async()=>{},connect:async()=>({
    release:()=>{},query:async(sql:string,args:unknown[]=[])=>{
      state.sql.push({sql,args});const rows=(rows:unknown[])=>({rows,rowCount:rows.length});
      if(/^(BEGIN|ROLLBACK|COMMIT|SELECT set_config|SELECT pg_advisory_xact_lock)/.test(sql))return rows([]);
      if(sql.includes("FROM public.employees"))return rows([{id:21,firstName:"Fixture",lastName:"Employee",masterSalary:"5000000"}]);
      if(sql.includes("FROM public.payroll_salary_profiles")||sql.includes("FROM public.payroll_deduction_settings"))return rows([]);
      if(sql.includes("INSERT INTO public.payroll_salary_profiles"))return rows([]);
      if(sql.includes("INSERT INTO public.payroll_deduction_settings")){if(state.failWrite)throw Error("FIXTURE_FAILURE");return rows([]);}
      throw Error("UNEXPECTED_QUERY");
    },
  })}),
}));
describe("restored DEV Payroll components",()=>{
  beforeEach(()=>{state.dev=true;state.role="super_admin";state.sql=[];state.shared=0;state.failWrite=false;
    vi.stubEnv("APP_ENV","development");
    vi.stubEnv("PAYROLL_DATABASE_URL_DEV","postgresql://bizportal_payroll_dev.xssrfshdrtdfupgqwfdw:fixture@127.0.0.1:65432/payroll_ci");
    vi.stubEnv("PAYROLL_DEV_COMPONENTS_ENABLED","");});
  afterEach(async()=>{const {closeDedicatedPayrollPool}=await import("./payroll-db");await closeDedicatedPayrollPool();vi.unstubAllEnvs();});
  const request=async(path:string,method="GET",body?:unknown)=>{
    const {default:router}=await import("./payroll");const app=express();app.use(express.json());app.use("/api",router);
    const server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const address=server.address();if(!address||typeof address==="string")throw Error("NO_TEST_SERVER");
    try{const r=await fetch("http://127.0.0.1:"+address.port+"/api/payroll/"+path,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
    finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  };
  const fixture={baseSalary:"5000000",allowance:"100000",bpjsJhtEmployee:"100000",bpjsKesEmployee:"50000",pph21:"0",otherDeductions:"0",kasbonDeduction:"0",effectiveFrom:"2026-11-01",notes:"Fixture HR confirmation",confirm:true};
  it("preserves HRD reference separately and leaves unconfirmed fields empty",async()=>{
    expect((await request("capabilities?companyId=1")).data).toMatchObject({canReviewComponents:true,canEditComponents:false,canCalculate:false,canPay:false});
    const r=await request("components/21?companyId=1");
    expect(r.status).toBe(200);expect(r.data).toMatchObject({employeeId:21,masterSalaryCandidate:"5000000",complete:false,values:{baseSalary:null,allowance:null,kasbonDeduction:null}});
    expect(state.sql.some(x=>x.sql==="BEGIN READ ONLY")).toBe(true);expect(state.shared).toBe(0);
  });
  it("requires signed Owner/Super Admin scope and rejects cross-company access",async()=>{
    state.role="";expect((await request("components/employees?companyId=1")).status).toBe(401);
    state.role="owner";expect((await request("components/employees?companyId=2")).status).toBe(403);
    state.role="admin";expect((await request("components/employees?companyId=1")).status).toBe(403);
    expect(state.sql).toHaveLength(0);
  });
  it("keeps writes disabled by default",async()=>{
    expect((await request("components/21?companyId=1","PUT",fixture)).status).toBe(501);
    expect(state.sql).toHaveLength(0);expect(state.shared).toBe(0);
  });
  it("rejects unconfirmed writes and positive manual kasbon",async()=>{
    vi.stubEnv("PAYROLL_DEV_COMPONENTS_ENABLED","true");
    expect((await request("components/21?companyId=1","PUT",{...fixture,confirm:false})).status).toBe(400);
    expect((await request("components/21?companyId=1","PUT",{...fixture,kasbonDeduction:"500000"})).status).toBe(409);
    expect(state.sql).toHaveLength(0);
  });
  it("saves only one salary profile and five component settings in the fixture",async()=>{
    vi.stubEnv("PAYROLL_DEV_COMPONENTS_ENABLED","true");
    const r=await request("components/21?companyId=1","PUT",fixture);
    expect(r.status).toBe(200);expect(r.data).toMatchObject({componentsSaved:7,gross:"5100000.00",net:"4950000.00",appliedToPayroll:false,posted:false,paid:false,settledKasbon:false});
    const writes=state.sql.filter(x=>/INSERT INTO/.test(x.sql));
    expect(writes).toHaveLength(6);expect(writes.every(x=>/INSERT INTO public.payroll_(salary_profiles|deduction_settings)/.test(x.sql)&&x.args[0]===1)).toBe(true);
    expect(state.sql.at(-1)?.sql).toBe("COMMIT");expect(state.shared).toBe(0);
  });
  it("rolls back on component failure without committing",async()=>{
    vi.stubEnv("PAYROLL_DEV_COMPONENTS_ENABLED","true");state.failWrite=true;
    expect((await request("components/21?companyId=1","PUT",fixture)).status).toBe(503);
    expect(state.sql.at(-1)?.sql).toBe("ROLLBACK");expect(state.sql.some(x=>x.sql==="COMMIT")).toBe(false);
  });
});
