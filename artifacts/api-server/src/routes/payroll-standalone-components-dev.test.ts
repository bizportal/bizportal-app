import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import {once} from "node:events";
import {createServer} from "node:http";
const state=vi.hoisted(()=>({dev:true,role:"super_admin",sql:[] as {sql:string;args:unknown[]}[],shared:0,failWrite:false,hasVersions:false}));
vi.mock("./dev-auth",()=>({isDevelopmentEnvironment:()=>state.dev,getProductionSession:()=>null,getProductionUser:async()=>null,
  getDevSession:()=>state.role?{id:"qa",email:"qa@example.invalid",role:state.role,companyId:1}:null}));
vi.mock("@workspace/db",()=>({
  pool:{connect:async()=>{state.shared++;throw Error("SHARED_POOL_FORBIDDEN");},query:async()=>{state.shared++;throw Error("SHARED_POOL_FORBIDDEN");}},
  createDedicatedPayrollPool:()=>({end:async()=>{},connect:async()=>({
    release:()=>{},query:async(sql:string,args:unknown[]=[])=>{
      state.sql.push({sql,args});const rows=(rows:unknown[])=>({rows,rowCount:rows.length});
      if(/^(BEGIN|ROLLBACK|COMMIT|SELECT set_config|SELECT pg_advisory_xact_lock)/.test(sql))return rows([]);
      if(sql.includes("FROM public.employees")){
        const roster=[
          {id:21,companyId:1,firstName:"Fixture",lastName:"CST",masterSalary:"5000000"},
          {id:22,companyId:2,firstName:"Fixture",lastName:"Other Company",masterSalary:"6000000"},
        ];
        // The fixture must honor the query's tenant and employee predicates.
        // Otherwise a globally authorized Owner appears to read unrelated rows.
        const listing=sql.includes("ORDER BY first_name");
        const idFirst=sql.includes("WHERE id=$1 AND company_id=$2");
        const companyId=Number(args[idFirst?1:0]);
        const employeeId=listing?null:Number(args[idFirst?0:1]);
        return rows(roster.filter(e=>e.companyId===companyId&&(listing||e.id===employeeId))
          .map(e=>listing?{id:e.id,firstName:e.firstName,lastName:e.lastName}:
            {id:e.id,masterSalary:e.masterSalary}));
      }
      if(sql.includes("FROM public.payroll_salary_profiles")){
        if(!state.hasVersions)return rows([]);
        const versions=[
          {effectiveFrom:"2026-12-01",baseSalary:"6000000.00",allowance:"0.00",notes:"Fixture December"},
          {effectiveFrom:"2026-11-01",baseSalary:"5000000.00",allowance:"100000.00",notes:"Fixture November"},
        ];
        return rows(versions.filter(v=>args[2]==null||v.effectiveFrom===args[2]).slice(0,1));
      }
      if(sql.includes("FROM public.payroll_deduction_settings")){
        if(!state.hasVersions)return rows([]);
        return rows(["bpjs_jht_employee","bpjs_kes_employee","pph21","other_deductions","kasbon_deduction"].map(code=>({code,amount:"0.00",notes:"Fixture"})));
      }
      if(sql.includes("INSERT INTO public.payroll_salary_profiles"))return rows([]);
      if(sql.includes("INSERT INTO public.payroll_deduction_settings")){if(state.failWrite)throw Error("FIXTURE_FAILURE");return rows([]);}
      throw Error("UNEXPECTED_QUERY");
    },
  })}),
}));
describe("restored DEV Payroll components",()=>{
  beforeEach(()=>{state.dev=true;state.role="super_admin";state.sql=[];state.shared=0;state.failWrite=false;state.hasVersions=false;
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
    expect(state.sql.some(x=>x.sql==="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")).toBe(true);expect(state.shared).toBe(0);
  });
  it("requires a signed Owner or Super Admin and rejects restricted roles before SQL",async()=>{
    state.role="";expect((await request("components/employees?companyId=1")).status).toBe(401);
    state.role="finance";expect((await request("components/employees?companyId=2")).status).toBe(403);
    state.role="accounting";expect((await request("components/employees?companyId=2")).status).toBe(403);
    state.role="admin";expect((await request("components/employees?companyId=2")).status).toBe(403);
    expect((await request("components/employees?companyId=1")).status).toBe(403);
    expect(state.sql).toHaveLength(0);expect(state.shared).toBe(0);
  });
  it.each(["owner","super_admin"])("permits %s to select an explicit company without leaking another company's employees",async role=>{
    state.role=role;
    const result=await request("components/employees?companyId=2");
    expect(result.status).toBe(200);
    expect(result.data).toEqual({companyId:2,employees:[{id:22,firstName:"Fixture",lastName:"Other Company"}],canEdit:false});
    expect(state.sql.some(q=>q.sql.includes("set_config")&&q.args[0]==="2")).toBe(true);
    expect(state.sql.some(q=>q.sql.includes("FROM public.employees")&&q.sql.includes("company_id=$1")&&q.args[0]===2)).toBe(true);
    const own=await request("components/22?companyId=2");
    expect(own.status).toBe(200);
    expect(own.data).toMatchObject({companyId:2,employeeId:22,masterSalaryCandidate:"6000000"});
    const foreign=await request("components/21?companyId=2");
    expect(foreign.status).toBe(404);
    vi.stubEnv("PAYROLL_DEV_COMPONENTS_ENABLED","true");
    expect((await request("components/21?companyId=2","PUT",fixture)).status).toBe(404);
    expect(state.sql.some(q=>q.sql.includes("INSERT INTO"))).toBe(false);
    expect(state.shared).toBe(0);
  });
  it("never enables the restored component routes in PROD or without an explicit company",async()=>{
    expect((await request("components/employees?companyId=all")).status).toBe(403);
    state.dev=false;vi.stubEnv("APP_ENV","production");vi.stubEnv("PAYROLL_DEV_COMPONENTS_ENABLED","true");
    // No production session is supplied by this fixture.
    expect((await request("components/employees?companyId=1")).status).toBe(401);
    expect(state.sql).toHaveLength(0);
  });
  it("reads the exact effective-date version instead of a newer salary profile",async()=>{
    state.hasVersions=true;
    const latest=await request("components/21?companyId=1");
    expect(latest.status).toBe(200);
    expect(latest.data).toMatchObject({effectiveFrom:"2026-12-01",values:{baseSalary:"6000000.00"}});
    const saved=await request("components/21?companyId=1&effectiveFrom=2026-11-01");
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({employeeId:21,companyId:1,effectiveFrom:"2026-11-01",complete:true,values:{baseSalary:"5000000.00",allowance:"100000.00"}});
    expect(state.sql.some(q=>q.sql.includes("FROM public.payroll_salary_profiles")&&q.sql.includes("effective_from=$3::date")&&q.args[2]==="2026-11-01")).toBe(true);
    expect(state.sql.some(q=>q.sql.includes("FROM public.payroll_deduction_settings")&&q.args[2]==="2026-11-01")).toBe(true);
    const missing=await request("components/21?companyId=1&effectiveFrom=2026-10-01");
    expect(missing.status).toBe(200);expect(missing.data).toMatchObject({effectiveFrom:null,complete:false});
    state.sql=[];
    expect((await request("components/21?companyId=1&effectiveFrom=2026-11-31")).status).toBe(400);
    expect(state.sql).toHaveLength(0);expect(state.shared).toBe(0);
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
