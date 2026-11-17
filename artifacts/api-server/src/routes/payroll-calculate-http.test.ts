import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  signed:true,session:true,role:"super_admin",dedicated:true,
  writes:0, pool:{connect:vi.fn()}, calculate:vi.fn(),
}));
vi.mock("./dev-auth",()=>({
  isSignedOtpDevEnabled:()=>state.signed,
  getProductionSession:()=>state.session?{id:"synthetic-signed-otp"}:null,
  getProductionUser:async()=>({id:"test-actor",email:"test@example.invalid",
    role:state.role,companyId:1,firstName:null,lastName:null}),
}));
vi.mock("./payroll-db",()=>({
  payrollDedicatedEnabled:()=>state.dedicated,
  getPayrollPool:()=>state.pool,
}));
vi.mock("./payroll-calculate",()=>({
  calculateDevPayroll:(...args:unknown[])=>state.calculate(...args),
}));
import { createDevPayrollCalculateRouter } from "./payroll-calculate-http";

describe("DEV Payroll Calculate signed-only HTTP boundary",()=>{
  let server:Server,root:string;
  async function mount() {
    const app=express();app.use(express.json());
    app.use("/api",createDevPayrollCalculateRouter());
    server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
    const addr=server.address();
    if(!addr||typeof addr==="string")throw Error("HTTP_BIND");
    root="http://127.0.0.1:"+addr.port+"/api/payroll/runs/32/calculate?companyId=1";
  }
  async function close(){
    if(server){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  }
  const send=async(options?:{origin?:string;contentType?:string;body?:string;url?:string})=>{
    const headers:Record<string,string>={"Content-Type":options?.contentType??"application/json",
      Origin:options?.origin??"http://127.0.0.1:19002"};
    return fetch(options?.url??root,{method:"POST",headers,body:options?.body??"{}"});
  };
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","development");
    vi.stubEnv("NODE_ENV","test");
    vi.stubEnv("PAYROLL_DEV_CALCULATE_ENABLED","true");
    vi.stubEnv("PAYROLL_DEV_CALCULATE_ALLOWED_ORIGIN","http://127.0.0.1:19002");
    state.signed=true;state.session=true;state.role="super_admin";state.dedicated=true;state.writes=0;
    state.pool.connect.mockClear();state.calculate.mockReset();
    state.calculate.mockImplementation(async()=>{
      state.writes++;
      return {companyId:1,runId:32,status:"draft",net:"1900.00",
        preparedReservations:1,approved:false,accountingPosted:false,salaryPaid:false};
    });
  });
  afterEach(async()=>{await close();vi.unstubAllEnvs();});
  it("not mounted in PROD even with feature switch",async()=>{
    vi.stubEnv("APP_ENV","production");await mount();
    expect((await send()).status).toBe(404);expect(state.writes).toBe(0);
  });
  it("not mounted if calculate flag is OFF",async()=>{
    vi.stubEnv("PAYROLL_DEV_CALCULATE_ENABLED","");await mount();
    expect((await send()).status).toBe(404);expect(state.writes).toBe(0);
  });
  it("does not admit a legacy session without signed OTP",async()=>{
    await mount();state.session=false;
    expect((await send()).status).toBe(401);expect(state.writes).toBe(0);
  });
  it("rejects unsigned OTP mode before any pool",async()=>{
    await mount();state.signed=false;
    expect((await send()).status).toBe(503);expect(state.writes).toBe(0);
  });
  it("rejects other roles, including Owner",async()=>{
    await mount();state.role="owner";
    expect((await send()).status).toBe(403);
    state.role="finance";expect((await send()).status).toBe(403);
    expect(state.writes).toBe(0);
  });
  it("rejects another company, bad scope and invalid body",async()=>{
    await mount();
    expect((await send({url:root.replace("companyId=1","companyId=bad")})).status).toBe(400);
    state.role="admin";expect((await send()).status).toBe(403);
    state.role="super_admin";
    expect((await send({body:'{"status":"approved"}'})).status).toBe(400);
    expect(state.writes).toBe(0);
  });
  it("rejects missing or foreign Origin, incorrect content type",async()=>{
    await mount();
    expect((await send({origin:"http://other.invalid"})).status).toBe(403);
    expect((await send({contentType:"text/plain"})).status).toBe(415);
    expect(state.writes).toBe(0);
  });
  it("refuses missing dedicated payroll reader/writer, no shared pool",async()=>{
    await mount();state.dedicated=false;
    expect((await send()).status).toBe(503);expect(state.writes).toBe(0);
  });
  it("returns a prepared Draft but never claims approval/posting/payment",async()=>{
    await mount();const response=await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,companyId:1,runId:32,
      status:"draft",preparedReservations:1,approved:false,accountingPosted:false,salaryPaid:false});
    expect(state.calculate).toHaveBeenCalledWith(state.pool,1,32);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("fails closed after a switch is turned OFF on a mounted route",async()=>{
    await mount();vi.stubEnv("PAYROLL_DEV_CALCULATE_ENABLED","");
    expect((await send()).status).toBe(404);expect(state.writes).toBe(0);
  });
});
