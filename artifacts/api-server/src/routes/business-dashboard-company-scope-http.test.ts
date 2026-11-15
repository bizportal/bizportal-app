import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const mock = vi.hoisted(() => ({
  actor: { id:"dev-user",email:"actor@example.invalid",role:"finance",companyId:1 as number|null },
  query: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@workspace/db",()=>({pool:{query:mock.query}}));
vi.mock("./dev-auth",()=>({
  getDevSession:mock.session,
  getProductionSession:vi.fn(()=>null),
  getProductionUser:vi.fn(),
  isDevelopmentEnvironment:vi.fn(()=>true),
}));
import router from "./business-dashboard";
let server:Server, base:string;
beforeAll(async()=>{
  const app=express();
  app.use((req,_res,next)=>{(req as any).log={error:()=>{}};next();});
  app.use("/api",router);
  server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
beforeEach(()=>{
  mock.actor={id:"dev-user",email:"actor@example.invalid",role:"finance",companyId:1};
  mock.session.mockReset();
  mock.query.mockReset();
  mock.session.mockImplementation(()=>mock.actor);
  mock.query.mockResolvedValue({rows:[]});
});
const get=(query="")=>fetch(base+"/api/purchase/dashboard-kpi"+query);
describe("existing dashboard company binding",()=>{
  it.each(["finance","accounting","admin"])("denies %s requesting company 2 under a company 1 session before SQL",async role=>{
    mock.actor.role=role;
    const res=await get("?companyId=2");
    expect(res.status).toBe(403);
    expect(((await res.json()) as {code:string}).code).toBe("COMPANY_SCOPE_MISMATCH");
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("denies unbound finance before SQL even with a requested company",async()=>{
    mock.actor.companyId=null;
    const res=await get("?companyId=1");
    expect(res.status).toBe(403);
    expect(((await res.json()) as {code:string}).code).toBe("COMPANY_SCOPE_MISSING");
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("defaults a bound finance request to its own company",async()=>{
    const res=await get();
    expect(res.status).toBe(200);
    expect(mock.query).toHaveBeenCalledTimes(3);
    for(const call of mock.query.mock.calls)expect(call[1]).toContain(1);
  });
  it("allows an explicitly unbound Super Admin to request a company",async()=>{
    mock.actor.role="super_admin";mock.actor.companyId=null;
    const res=await get("?companyId=2");
    expect(res.status).toBe(200);
    expect(mock.query).toHaveBeenCalledTimes(3);
    for(const call of mock.query.mock.calls)expect(call[1]).toContain(2);
  });
  it("rejects malformed company filters without SQL",async()=>{
    const res=await get("?companyId=wrong");
    expect(res.status).toBe(400);
    expect(mock.query).not.toHaveBeenCalled();
  });
});
