import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
const mock = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), enabled: vi.fn(), query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: mock.query } }));
vi.mock("./dev-auth", () => ({
  getProductionSession: mock.session, getProductionUser: mock.user, isSignedOtpDevEnabled: mock.enabled,
}));
import router from "./dev-cst-kasbon-history";
import { DEV_CST_KASBON_HISTORY_SQL } from "./dev-cst-kasbon-history-sql";

const original = process.env.APP_ENV;
const session = { id: "fixture-owner", email: "owner@example.invalid" };
const actor = { ...session, role: "super_admin", companyId: 1 };
const sample = { id: 23, state: "APPROVED_NO_DISBURSEMENT", recordedAmount: "100000" };
let server: Server, base: string;
beforeAll(async () => {
  const app = express(); app.use("/api", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  if (original === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = original;
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  process.env.APP_ENV = "development"; vi.resetAllMocks();
  mock.enabled.mockReturnValue(true); mock.session.mockReturnValue(session);
  mock.user.mockResolvedValue(actor);
  mock.query.mockResolvedValue({rows:[{authorized:true,total:1,records:[sample]}]});
});
const get=(q="?companyId=1")=>fetch(base+"/api/advances/dev-kasbon-history"+q);
describe("CST-DEV employee kasbon history is read-only and signed-session scoped", () => {
  it("denies PROD before reading session or DB", async () => {
    process.env.APP_ENV="production"; expect((await get()).status).toBe(404);
    expect(mock.session).not.toHaveBeenCalled(); expect(mock.query).not.toHaveBeenCalled();
  });
  it("requires existing signed OTP config", async () => {
    mock.enabled.mockReturnValue(false); expect((await get()).status).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("denies unsigned session",async()=>{
    mock.session.mockReturnValue(null); expect((await get()).status).toBe(401);
    expect(mock.user).not.toHaveBeenCalled(); expect(mock.query).not.toHaveBeenCalled();
  });
  it.each(["","?companyId=2","?companyId=all","?companyId=1&companyId=2","?companyId=1&company=2","?companyId=1&employeeId=3"])(
    "rejects alternate company and arbitrary filters %s", async q=>{
      expect((await get(q)).status).toBe(403);expect(mock.query).not.toHaveBeenCalled();
    });
  it.each(["0","-1","01","1.5","10001","1&page=2"])("rejects bad page %s",async q=>{
    expect((await get("?companyId=1&page="+q)).status).toBe(400);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it.each([{...actor,companyId:2},{...actor,role:"finance"},{...actor,role:"staff"},{...actor,id:"different"},null])(
    "denies unrelated/revoked identity",async value=>{
      mock.user.mockResolvedValue(value); expect((await get()).status).toBe(403);
      expect(mock.query).not.toHaveBeenCalled();
    });
  it("returns recorded rows, never write capabilities",async()=>{
    const response=await get();expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({companyId:1,readOnly:true,page:1,pageSize:50,total:1,records:[sample]});
    expect(mock.query).toHaveBeenCalledWith(DEV_CST_KASBON_HISTORY_SQL,[actor.id,actor.email,actor.role,0]);
  });
  it("uses explicit CST selection for existing unbound Owner and actual page offset",async()=>{
    mock.user.mockResolvedValue({...actor,role:"owner",companyId:null});
    mock.query.mockResolvedValue({rows:[{authorized:true,total:51,records:[sample]}]});
    const r=await get("?companyId=1&page=2");expect(r.status).toBe(200);
    expect(mock.query).toHaveBeenCalledWith(DEV_CST_KASBON_HISTORY_SQL,[actor.id,actor.email,"owner",50]);
  });
  it("rechecks current DB authorization",async()=>{
    mock.query.mockResolvedValue({rows:[{authorized:false,total:0,records:[]}]});
    expect((await get()).status).toBe(403);
  });
  it("failure/incomplete result is not empty success",async()=>{
    mock.query.mockResolvedValue({rows:[{authorized:true,total:1,records:[]}]});
    expect((await get()).status).toBe(503);
    mock.query.mockRejectedValue(new Error("fixture failure"));expect((await get()).status).toBe(503);
  });
  it("distinguishes true empty from unavailable",async()=>{
    mock.query.mockResolvedValue({rows:[{authorized:true,total:0,records:[]}]});
    expect((await get()).status).toBe(200);
  });
  it.each(["POST","PATCH","DELETE"])("does not mount %s",async method=>{
    expect((await fetch(base+"/api/advances/dev-kasbon-history?companyId=1",{method})).status).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("same-statement active profile, exact tenant joins, general kasbon only",()=>{
    expect(DEV_CST_KASBON_HISTORY_SQL).toContain("e.company_id = c.company_id");
    expect(DEV_CST_KASBON_HISTORY_SQL).toContain("c.company_id = 1 AND c.type = 'kasbon' AND c.advance_type = 'EMPLOYEE'");
    expect(DEV_CST_KASBON_HISTORY_SQL).toContain("u.is_active IS TRUE AND u.status = 'active'");
    expect(DEV_CST_KASBON_HISTORY_SQL).not.toContain("source_system = 'ai_task_owner_wa'");
    expect(DEV_CST_KASBON_HISTORY_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|GRANT|ALTER|CREATE)\b/i);
    expect(DEV_CST_KASBON_HISTORY_SQL).not.toMatch(/\b(password_hash|phone|bank_account_number|notes)\b/i);
  });
});
