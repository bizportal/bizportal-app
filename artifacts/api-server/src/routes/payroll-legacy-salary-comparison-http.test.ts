import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import express from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";

const state=vi.hoisted(()=>({
  actor:{id:"owner",email:"owner@example.invalid",role:"super_admin"} as any,
  companyId:1,dev:true,dedicated:true,hasRun:true,sqlError:false,
  employees:[
    {id:21,first_name:"Karyawan",last_name:"Satu",legacy_salary:"6000000.00",
      base_salary:null,allowance:null,effective_from:null},
    {id:24,first_name:"Karyawan",last_name:"Dua",legacy_salary:"3000000.00",
      base_salary:"2500000.00",allowance:"500000.00",effective_from:"2026-11-01"},
  ] as Record<string,unknown>[],
  queries:[] as Array<{sql:string;args:unknown[]}>,
}));
vi.mock("./dev-auth",()=>({isDevelopmentEnvironment:()=>state.dev}));
vi.mock("./payroll-db",()=>({
  payrollDedicatedEnabled:()=>state.dedicated,
  setPayrollCompanyScope:async(_client:unknown,companyId:number)=>{expect(companyId).toBe(state.companyId);},
  getPayrollPool:()=>({connect:async()=>({
    release:()=>{},
    query:async(sql:string,args:unknown[]=[])=>{
      state.queries.push({sql,args});
      const r=(rows:Record<string,unknown>[])=>({rowCount:rows.length,rows});
      if(sql==="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"||sql==="COMMIT"||sql==="ROLLBACK")return r([]);
      if(sql.includes("FROM public.payroll_runs"))return r(state.hasRun?[{id:8,month:11,year:2026,status:"draft"}]:[]);
      if(sql.includes("FROM public.employees e")){
        if(state.sqlError)throw Object.assign(Error("DB_PRIVATE_PASSWORD"),{code:"42501"});
        return r(state.employees);
      }
      throw Error("UNEXPECTED_SQL");
    },
  })}),
}));
describe("DEV legacy salary comparison stays read-only",()=>{
  let server:Server,root:string;
  beforeAll(async()=>{
    const {registerPayrollLegacySalaryComparisonRoutes}=await import("./payroll-legacy-salary-comparison");
    const router=express.Router();
    router.use((req:any,_res,next)=>{
      req.payrollActor=state.actor;req.payrollCompanyId=state.companyId;
      req.log={error:()=>{}};next();
    });
    registerPayrollLegacySalaryComparisonRoutes(router);
    const app=express();app.use("/api",router);
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const address=server.address();if(!address||typeof address==="string")throw Error("SERVER_ADDRESS_UNAVAILABLE");
    root=`http://127.0.0.1:${address.port}/api/payroll/runs/8/legacy-salary-comparison`;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{
    process.env.APP_ENV="development";
    state.actor={id:"owner",email:"owner@example.invalid",role:"super_admin"};
    state.companyId=1;state.dev=true;state.dedicated=true;state.hasRun=true;state.sqlError=false;
    state.employees=[
      {id:21,first_name:"Karyawan",last_name:"Satu",legacy_salary:"6000000.00",
        base_salary:null,allowance:null,effective_from:null},
      {id:24,first_name:"Karyawan",last_name:"Dua",legacy_salary:"3000000.00",
        base_salary:"2500000.00",allowance:"500000.00",effective_from:"2026-11-01"},
    ];
    state.queries=[];
  });
  it("shows old value as unclassified reference, never guesses an allowance or approves payroll",async()=>{
    const response=await fetch(root);expect(response.status).toBe(200);
    const body=await response.json() as any;
    expect(body).toMatchObject({companyId:1,runId:8,activeEmployees:2,
      withPositiveLegacyAmount:2,withoutEffectiveSalaryProfile:1,numericMatches:1,
      legacyReferenceTotal:"9000000.00",configuredComparisonTotal:"3000000.00",
      source:"public.employees.salary",legacyAmountSemantics:"UNKNOWN",
      readOnly:true,canImport:false,canMaterialize:false,canPost:false,canPay:false});
    expect(body.rows[0]).toMatchObject({legacySalary:"6000000.00",configuredBaseSalary:null,
      configuredAllowance:null,configuredTotal:null,componentsVerified:false,
      status:"SALARY_COMPONENTS_NOT_CONFIGURED"});
    expect(body.rows[1]).toMatchObject({configuredBaseSalary:"2500000.00",
      configuredAllowance:"500000.00",configuredTotal:"3000000.00",
      differenceFromLegacy:"0.00",status:"NUMBERS_MATCH_COMPONENTS_UNVERIFIED",
      componentsVerified:false});
    expect(state.queries[0].sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(state.queries.at(-1)?.sql).toBe("COMMIT");
    const employeesQuery=state.queries.find(q=>q.sql.includes("FROM public.employees e"));
    expect(employeesQuery?.args).toEqual([1,"2026-11-30"]);
    expect(employeesQuery?.sql).toContain("e.company_id=$1");
    expect(employeesQuery?.sql).toContain("e.status='active'");
    expect(employeesQuery?.sql).toContain("e.deleted_at IS NULL");
    expect(employeesQuery?.sql).toContain("s.company_id=$1");
    expect(state.queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(q.sql))).toBe(true);
  });
  it("rejects absent or unauthorized user, cross-company and non-DEV",async()=>{
    state.actor=null;expect((await fetch(root)).status).toBe(403);
    state.actor={id:"other",email:"other@example.invalid",role:"accounting"};expect((await fetch(root)).status).toBe(403);
    state.actor={id:"other",email:"owner@example.invalid",role:"finance"};expect((await fetch(root)).status).toBe(403);
    state.actor={id:"owner",email:"owner@example.invalid",role:"super_admin"};
    state.companyId=0;expect((await fetch(root)).status).toBe(400);
    state.companyId=1;state.dev=false;expect((await fetch(root)).status).toBe(404);
    state.dev=true;state.dedicated=false;expect((await fetch(root)).status).toBe(503);
    expect(state.queries).toHaveLength(0);
  });
  it("never substitutes fake amounts when legacy salary invalid",async()=>{
    state.employees=[{id:21,first_name:"Test",last_name:"Invalid",legacy_salary:null,base_salary:null,
      allowance:null,effective_from:null}];
    const r=await fetch(root);expect(r.status).toBe(200);
    const data=await r.json() as any;
    expect(data).toMatchObject({withPositiveLegacyAmount:0,legacyReferenceTotal:null,configuredComparisonTotal:null});
    expect(data.rows[0]).toMatchObject({legacySalary:null,status:"LEGACY_AMOUNT_INVALID",componentsVerified:false});
  });
  it("fails closed on missing draft and too many active employees",async()=>{
    state.hasRun=false;expect((await fetch(root)).status).toBe(404);
    state.hasRun=true;
    state.employees=Array.from({length:201},(_,i)=>({id:i+1,first_name:"X",last_name:"",
      legacy_salary:"1000000",base_salary:null,allowance:null,effective_from:null}));
    const res=await fetch(root);expect(res.status).toBe(409);
    expect((await res.json() as any).message).toMatch(/tidak dipotong/i);
    expect(state.queries.every(q=>!q.sql.includes("INSERT INTO"))).toBe(true);
  });
  it("rolls back on revoked salary privilege and never leaks sensitive SQL error",async()=>{
    state.sqlError=true;
    const r=await fetch(root);expect(r.status).toBe(503);
    const body=await r.json();expect(JSON.stringify(body)).not.toContain("DB_PRIVATE_PASSWORD");
    expect(state.queries.at(-1)?.sql).toBe("ROLLBACK");
  });
});
