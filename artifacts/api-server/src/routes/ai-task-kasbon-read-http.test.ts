import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const mock = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), enabled: vi.fn(), query: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mock.query } }));
vi.mock("./dev-auth", () => ({
  getProductionSession: mock.session,
  getProductionUser: mock.user,
  isSignedOtpDevEnabled: mock.enabled,
}));
import router from "./ai-task-kasbon-read";
import { AI_TASK_KASBON_READ_SQL } from "./ai-task-kasbon-read-sql";

const originalAppEnv = process.env.APP_ENV;
const session = { id: "fixture-user", email: "fixture@example.invalid" };
const actor = { ...session, role: "super_admin", companyId: 1 };
let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use("/api", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  if (originalAppEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = originalAppEnv;
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  process.env.APP_ENV = "development";
  vi.resetAllMocks();
  mock.enabled.mockReturnValue(true);
  mock.session.mockReturnValue(session);
  mock.user.mockResolvedValue(actor);
  mock.query.mockResolvedValue({ rows: [{ authorized: true, records: [], truncated: false }] });
});
const get = (query = "?companyId=1") => fetch(base + "/api/advances/ai-task-reconciliation" + query);
describe("DEV-only finance-owned AI Task reconciliation", () => {
  it("production never reads a session or database", async () => {
    process.env.APP_ENV = "production";
    expect((await get()).status).toBe(404);
    expect(mock.session).not.toHaveBeenCalled();
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("requires existing signed OTP DEV configuration", async () => {
    mock.enabled.mockReturnValue(false);
    expect((await get()).status).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("rejects missing signed session without any fallback", async () => {
    mock.session.mockReturnValue(null);
    expect((await get()).status).toBe(401);
    expect(mock.user).not.toHaveBeenCalled();
    expect(mock.query).not.toHaveBeenCalled();
  });
  it.each(["", "?companyId=2", "?companyId=01", "?companyId=1&companyId=2", "?companyId=1&taskId=182"])(
    "denies unsupported selection %s", async query => {
      expect((await get(query)).status).toBe(403);
      expect(mock.user).not.toHaveBeenCalled();
      expect(mock.query).not.toHaveBeenCalled();
    });
  it.each([
    { ...actor, companyId: 2 }, { ...actor, role: "finance" },
    { ...actor, role: "staff" }, { ...actor, id: "different" },
    { ...actor, email: "other@example.invalid" }, null,
  ])("denies mismatched or inactive profile", async invalid => {
    mock.user.mockResolvedValue(invalid);
    expect((await get()).status).toBe(403);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it.each([actor, { ...actor, role: "owner", companyId: null }, { ...actor, companyId: null }])(
    "reuses established Owner/Super Admin explicit CST selection", async allowed => {
      mock.user.mockResolvedValue(allowed);
      const records = [{ advanceId: 23, taskId: 182, state: "APPROVED_NO_DISBURSEMENT",
        approvalRecorded: true, disbursementRecorded: false, journalReferenceRecorded: false }];
      mock.query.mockResolvedValue({ rows: [{ authorized: true, records, truncated: false }] });
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ companyId: 1, records, truncated: false });
      expect(mock.query).toHaveBeenCalledTimes(1);
      expect(mock.query).toHaveBeenCalledWith(AI_TASK_KASBON_READ_SQL, [allowed.id, allowed.email, allowed.role]);
    });
  it("rejects a revoked profile during the same SQL snapshot", async () => {
    mock.query.mockResolvedValue({ rows: [{ authorized: false, records: [], truncated: false }] });
    expect((await get()).status).toBe(403);
  });
  it("database failure is not an empty successful finance list", async () => {
    mock.query.mockRejectedValue(new Error("fixture failure"));
    expect((await get()).status).toBe(503);
  });
  it("does not mount a mutation", async () => {
    expect((await fetch(base + "/api/advances/ai-task-reconciliation?companyId=1", { method: "POST" })).status).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it("only reads the fixed financial source and exact task references", () => {
    expect(AI_TASK_KASBON_READ_SQL).toContain("c.company_id = 1");
    expect(AI_TASK_KASBON_READ_SQL).toContain("c.source_system = 'ai_task_owner_wa'");
    expect(AI_TASK_KASBON_READ_SQL).toContain("a.task_number = c.reference_number");
    expect(AI_TASK_KASBON_READ_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|GRANT|CREATE)\b/i);
    expect(AI_TASK_KASBON_READ_SQL).not.toMatch(/\b(party_name|amount|notes|customer_phone|password_hash)\b/i);
  });
});
