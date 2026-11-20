import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const fixture = vi.hoisted(() => ({
  enabled: true,
  user: {id:"otp-user-id",email:"super.admin@example.test",role:"super_admin"} as null | {id:string,email:string,role:string},
  updates:0,
  rows:["1-1025-DV","1-1035-DV","4-1026-DV","4-1027-DV"].map((code,i)=>({
    id:i+1,code,name:"DEV COA "+code,account_type:code.startsWith("1-")?"asset":"revenue",
    normal_balance:code==="4-1026-DV"?"CREDIT":"DEBIT",is_active:true,is_postable:true,is_header:false,status:"ACTIVE",
    approved_by:null as string|null,approved_at:null as string|null,
  })),
}));
vi.mock("../routes/dev-auth",()=>({
  isSignedOtpDevEnabled:()=>fixture.enabled,
  getProductionSession:()=>fixture.user?{id:fixture.user.id,email:fixture.user.email}:null,
  getProductionUser:async()=>fixture.user,
}));
vi.mock("@workspace/db/fleet-finance-dev",()=>({
  withFleetFinanceDevTransaction:async(_scope:unknown,fn:(client:any)=>Promise<any>, options?:{readOnly?:boolean})=>{
    const snapshot=fixture.rows.map(row=>({...row}));
    const client={query:async(sql:string,params:unknown[]=[])=>{
      if(sql.includes("SELECT id,code,name,type::text"))return {rows:fixture.rows.map(row=>({...row})),rowCount:fixture.rows.length};
      if(sql.includes("set_config("))return {rows:[{}],rowCount:1};
      if(sql.includes("UPDATE public.chart_of_accounts")){
        if(options?.readOnly)throw Error("WRITE_IN_READ_ONLY");
        let count=0;for(const row of fixture.rows){
          if(row.approved_by===null && row.approved_at===null){
            row.approved_by=String(params[0]);row.approved_at="2026-11-20T00:00:00Z";count++;
          }
        }
        fixture.updates++;
        return {rows:fixture.rows.map(row=>({...row})),rowCount:count};
      }
      throw Error("Unexpected SQL");
    }};
    try{return await fn(client)}catch(e){fixture.rows=snapshot;throw e}
  },
}));
import router from "../routes/gojek-rental-superadmin-approval";
let appServer:Server,origin:string;
beforeEach(async()=>{
  fixture.enabled=true;
  fixture.user={id:"otp-user-id",email:"super.admin@example.test",role:"super_admin"};
  fixture.updates=0;
  fixture.rows=fixture.rows.map(row=>({...row,approved_at:null,approved_by:null}));
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_FLEET_GOJEK_APPROVAL_ENABLED_DEV="true";
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).log={error:()=>{}};next()});app.use("/api",router);
  appServer=await new Promise<Server>(resolve=>{let s=app.listen(0,"127.0.0.1",()=>resolve(s))});
  let address=appServer.address();if(!address||typeof address==="string")throw Error("no port");origin="http://127.0.0.1:"+address.port;
});
afterEach(async()=>{
  await new Promise<void>((resolve,reject)=>appServer.close(e=>e?reject(e):resolve()));
});
const approvalBody={sourceCompanyId:1,financeCompanyId:3,confirmRentalRevenue:true,confirmDeductionClearing:true,confirmRebateAndTaxReview:true};
async function call(method:"GET"|"POST",options:{body?:unknown;origin?:string}={}) {
  const res=await fetch(origin+"/api/accounting/gojek-rental-approval",{
    method,headers:{...(method==="POST"?{"content-type":"application/json",origin:options.origin??"https://dev-bizportal.cstlogistic.co.id"}:{})},
    ...(method==="POST"?{body:JSON.stringify(options.body??approvalBody)}:{}),
  });return {status:res.status,body:await res.json() as {accounts:unknown[];canApprove:boolean;postingEnabled:boolean;idempotent:boolean}};
}
describe("Super Admin accounting approval button backend — isolated HTTP",()=>{
  it("preview shows exactly four pending COAs, no posting",async()=>{
    const r=await call("GET");expect(r.status).toBe(200);expect(r.body.accounts).toHaveLength(4);expect(r.body.canApprove).toBe(true);
    expect(r.body.postingEnabled).toBe(false);expect(fixture.updates).toBe(0);
  });
  it("denies stale or unverified user and non-Super Admin",async()=>{
    fixture.user=null;expect((await call("GET")).status).toBe(403);expect((await call("POST")).status).toBe(403);
    fixture.user={id:"otp-user-id",email:"staff@example.test",role:"finance"};
    expect((await call("POST")).status).toBe(403);expect(fixture.updates).toBe(0);
  });
  it("requires same-origin POST and explicit review of all treatments",async()=>{
    expect((await call("POST",{origin:"https://untrusted.example"})).status).toBe(403);
    expect((await call("POST",{body:{...approvalBody,confirmRebateAndTaxReview:false}})).status).toBe(400);
    expect((await call("POST",{body:{...approvalBody,financeCompanyId:1}})).status).toBe(400);
    expect(fixture.updates).toBe(0);
  });
  it("commits one approval atomically and replays idempotently",async()=>{
    const first=await call("POST");expect(first.status).toBe(201);expect(first.body).toMatchObject({approved:true,idempotent:false,accounts:4,postingEnabled:false});
    const repeat=await call("POST");expect(repeat.status).toBe(200);expect(repeat.body.idempotent).toBe(true);
    expect(fixture.updates).toBe(1);expect(fixture.rows.every(row=>row.approved_by==="super.admin@example.test")).toBe(true);
  });
  it("does not partially approve wrong Company3 COA mapping",async()=>{
    fixture.rows[1].normal_balance="CREDIT";
    expect((await call("POST")).status).toBe(409);expect(fixture.updates).toBe(0);
  });
  it("fails closed when DEV feature is disabled",async()=>{
    process.env.BIZPORTAL_FLEET_GOJEK_APPROVAL_ENABLED_DEV="false";
    expect((await call("POST")).status).toBe(404);expect(fixture.updates).toBe(0);
  });
});
