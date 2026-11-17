import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
const state = vi.hoisted(() => ({ signed: true, ready: true,
  actor: { id: "verified-admin", email: "admin@example.test", role: "super_admin", companyId: null as number | null },
  missingActor: false, preflightError: false, preflightCalls: 0, preflightWait: null as Promise<void> | null, error: "", calls: [] as unknown[] }));
vi.mock("./dev-auth", () => ({
  isSignedOtpDevEnabled: () => state.ready,
  getProductionSession: () => state.signed ? { id: state.actor.id, email: state.actor.email } : null,
  getProductionUser: async () => state.missingActor ? null : state.actor,
}));
vi.mock("./payroll-accounting-runtime-preflight", () => ({
  verifyPayrollSettlementRuntime: async () => {
    state.preflightCalls++;
    if (state.preflightWait) await state.preflightWait;
    if (state.preflightError) throw Error("PAYROLL_RUNTIME_PREFLIGHT_REJECTED");
    return { structuralChecksPassed: true, readOnly: true };
  },
}));
vi.mock("./payroll-accounting-transaction", () => ({
  postReviewedPayrollAccrualTransaction: async (_pool: unknown, _writer: unknown, request: unknown) => {
    state.calls.push(request); if (state.error) throw Error(state.error);
    return { entryId: 801, reused: false, salaryPaid: false };
  },
}));
let server: Server | undefined, base = "";
const origin = "https://payroll-dev.example.test";
const body = { expectedDigest: "a".repeat(64), postingDate: "2026-11-17" };
async function start(bind = true) {
  const api = await import("./payroll-accounting-http");
  if (bind) await api.bindDevPayrollAtomicHttpRuntime({ pool: { connect: vi.fn() },
    writer: { transactionalAccrualVersion: "payroll-accrual-atomic-v1", postAccrualJournal: vi.fn() }, allowedOrigin: origin });
  const app = express();app.use(express.json({ limit: "8kb" }));
  app.use("/api", api.createPayrollAtomicAccountingRouter());
  server = createServer(app);server.listen(0, "127.0.0.1");await once(server, "listening");
  const address = server.address();if (!address || typeof address === "string") throw Error("HTTP_NOT_READY");
  base = `http://127.0.0.1:${address.port}/api/payroll/runs/32/post-accounting?companyId=1`;
  return api;
}
async function post(value: unknown = body, headers: Record<string, string> = {}, url = base) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(value) });
}
beforeEach(() => {
  vi.resetModules();vi.stubEnv("APP_ENV", "development");vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED", "true");vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED", "true");
  state.preflightError = false;state.preflightCalls = 0;state.preflightWait = null;
  state.signed = true;state.ready = true;state.missingActor = false;state.error = "";state.calls.length = 0;
  state.actor = { id: "verified-admin", email: "admin@example.test", role: "super_admin", companyId: null };
});
afterEach(async () => { if (server) { server.closeAllConnections();await new Promise<void>(resolve => server!.close(() => resolve()));server = undefined; }vi.unstubAllEnvs(); });

describe("DEV signed Payroll accounting HTTP boundary", () => {
  it.each(["production", ""])("has no route or binding in APP_ENV=%s", async env => {
    vi.stubEnv("APP_ENV", env);const api = await start(false);
    expect((await post()).status).toBe(404);expect(state.calls).toHaveLength(0);
    await expect(api.bindDevPayrollAtomicHttpRuntime({} as never)).rejects.toThrow("DEV_DISABLED");
  });
  it.each(["PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED", "PAYROLL_DEV_ATOMIC_POSTING_ENABLED"])("stays absent when %s is off", async key => {
    vi.stubEnv(key, "");await start(false);expect((await post()).status).toBe(404);expect(state.calls).toHaveLength(0);
  });
  it("rechecks activation after route registration", async () => {
    await start();vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED", "false");
    expect((await post()).status).toBe(404);expect(state.calls).toHaveLength(0);
  });
  it("requires signed-session mode and never falls back to a DEV cookie", async () => {
    await start();state.ready = false;expect((await post()).status).toBe(503);
    state.ready = true;state.signed = false;
    expect((await post(body, { cookie: "bizportal_dev_session=fake-super-admin" })).status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });
  it.each(["owner", "admin", "finance", "accounting"])("denies the %s role", async role => {
    await start();state.actor.role = role;expect((await post()).status).toBe(403);expect(state.calls).toHaveLength(0);
  });
  it("denies an inactive/deleted signed actor", async () => {
    await start();state.missingActor = true;expect((await post()).status).toBe(403);expect(state.calls).toHaveLength(0);
  });
  it("successful replay is still derived from the service result rather than request input", async () => {
    await start();const response = await post({ ...body, reused: true });
    expect(response.status).toBe(400);expect(state.calls).toHaveLength(0);
  });
  it("refuses to bind if the direct database structural preflight fails", async () => {
    const api = await start(false);
    state.preflightError = true;
    await expect(api.bindDevPayrollAtomicHttpRuntime({ pool: { connect: vi.fn() },
      writer: { transactionalAccrualVersion: "payroll-accrual-atomic-v1", postAccrualJournal: vi.fn() },
      allowedOrigin: origin })).rejects.toThrow("PREFLIGHT_REJECTED");
    expect((await post()).status).toBe(503);
    expect(state.calls).toHaveLength(0);expect(state.preflightCalls).toBe(1);
  });
  it("keeps posting unavailable during preflight and coalesces the same initialization", async () => {
    const api = await start(false);let resolve!: () => void;
    state.preflightWait = new Promise<void>(done => { resolve = done; });
    const binding = { pool: { connect: vi.fn() }, writer: {
      transactionalAccrualVersion: "payroll-accrual-atomic-v1" as const, postAccrualJournal: vi.fn() }, allowedOrigin: origin };
    const one = api.bindDevPayrollAtomicHttpRuntime(binding), two = api.bindDevPayrollAtomicHttpRuntime(binding);
    expect((await post()).status).toBe(503);expect(state.calls).toHaveLength(0);
    await expect(api.bindDevPayrollAtomicHttpRuntime({ ...binding, pool: { connect: vi.fn() } }))
      .rejects.toThrow("REBIND_REQUIRES_RESTART");
    resolve();await Promise.all([one,two]);expect(state.preflightCalls).toBe(1);
    await api.bindDevPayrollAtomicHttpRuntime(binding);expect(state.preflightCalls).toBe(1);
    expect((await post()).status).toBe(200);
  });
  it("does not install a binding if a feature gate turns OFF during preflight", async () => {
    const api = await start(false);let resolve!: () => void;
    state.preflightWait = new Promise<void>(done => { resolve = done; });
    const binding = { pool: { connect: vi.fn() }, writer: {
      transactionalAccrualVersion: "payroll-accrual-atomic-v1" as const, postAccrualJournal: vi.fn() }, allowedOrigin: origin };
    const preparing = api.bindDevPayrollAtomicHttpRuntime(binding);
    const rejection = expect(preparing).rejects.toThrow("DEV_DISABLED");
    vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED","false");resolve();await rejection;
    vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED","true");
    expect((await post()).status).toBe(503);expect(state.calls).toHaveLength(0);
  });
  it("can retry after a failed preflight without retaining an unverified binding", async () => {
    const api = await start(false);
    const binding = { pool: { connect: vi.fn() }, writer: {
      transactionalAccrualVersion: "payroll-accrual-atomic-v1" as const, postAccrualJournal: vi.fn() }, allowedOrigin: origin };
    state.preflightError = true;
    await expect(api.bindDevPayrollAtomicHttpRuntime(binding)).rejects.toThrow("PREFLIGHT_REJECTED");
    expect((await post()).status).toBe(503);
    state.preflightError = false;await api.bindDevPayrollAtomicHttpRuntime(binding);
    expect(state.preflightCalls).toBe(2);expect((await post()).status).toBe(200);
  });
  it("does not acquire a fallback writer without server binding", async () => {
    await start(false);expect((await post()).status).toBe(503);expect(state.calls).toHaveLength(0);
  });
  it.each(["https://attacker.example.test", "null", ""])("rejects Origin %s", async value => {
    await start();expect((await post(body, { origin: value })).status).toBe(403);expect(state.calls).toHaveLength(0);
  });
  it("rejects cross-site requests even with a matching Origin header", async () => {
    await start();expect((await post(body, { "sec-fetch-site": "cross-site" })).status).toBe(403);expect(state.calls).toHaveLength(0);
  });
  it.each(["all", "0", "2147483648", "1&companyId=2"])("requires exactly one bounded company ID (%s)", async query => {
    await start();expect((await post(body, {}, base.replace("companyId=1", "companyId=" + query))).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });
  it.each([{ ...body, actor: { id: "other-admin" } }, { ...body, companyId: 2 },
    { ...body, amount: 1 }, { ...body, expectedDigest: "invalid" },
    { ...body, postingDate: "2026-02-30" }, null, []])("refuses body overrides and malformed input %j", async value => {
    await start();expect((await post(value)).status).toBe(400);expect(state.calls).toHaveLength(0);
  });
  it("does not accept form posts or GET financial side effects", async () => {
    await start();expect((await post(body, { "content-type": "text/plain" })).status).toBe(415);
    expect((await fetch(base)).status).toBe(404);expect(state.calls).toHaveLength(0);
  });
  it("derives actor and company only from verified server context", async () => {
    await start();const response = await post();expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, runId: 32, companyId: 1, entryId: 801,
      reused: false, accountingPosted: true, salaryPaid: false });
    expect(state.calls).toEqual([{ ...body, runId: 32, companyId: 1,
      actor: { id: "verified-admin", email: "admin@example.test", role: "super_admin" } }]);
  });
  it.each([["PAYROLL_ATOMIC_RUN_NOT_FOUND_IN_COMPANY", 404], ["PAYROLL_ATOMIC_APPROVAL_RECEIPT_MISMATCH", 409],
    ["PAYROLL_HANDOFF_OTHER_DEDUCTION_MAPPING_REQUIRED", 409],
    ["PAYROLL_ATOMIC_POSTING_PERIOD_NOT_CONFIGURED", 409], ["PAYROLL_ATOMIC_POSTING_PERIOD_CLOSED", 409],
    ["PAYROLL_ATOMIC_REPAYMENT_LEDGER_COUNT_CHANGED", 409], ["PAYROLL_ATOMIC_REPAYMENT_LEDGER_NOT_VERIFIED", 409],
    ["PAYROLL_ATOMIC_UNLINKED_JOURNAL_REQUIRES_RECOVERY", 409],
    ["postgresql://secret:password@private.invalid hidden SQL", 503]] as const)("redacts failure %s", async (error, expected) => {
    await start();state.error = error;const response = await post();expect(response.status).toBe(expected);
    const text = await response.text();expect(text).not.toContain(error);expect(text).not.toContain("password");
    expect(text).not.toContain("admin@example.test");
  });
  it("rejects rebind and non-TLS arbitrary origins", async () => {
    const api = await start();
    const binding = { pool: { connect: vi.fn() }, writer: { transactionalAccrualVersion: "payroll-accrual-atomic-v1" as const,
      postAccrualJournal: vi.fn() }, allowedOrigin: origin };
    await expect(api.bindDevPayrollAtomicHttpRuntime(binding)).rejects.toThrow("REBIND_REQUIRES_RESTART");
    await expect(api.bindDevPayrollAtomicHttpRuntime({ ...binding, allowedOrigin: "http://unsafe.example.test" })).rejects.toThrow("ORIGIN_INVALID");
    await expect(api.bindDevPayrollAtomicHttpRuntime({ ...binding, allowedOrigin: origin + "/other" })).rejects.toThrow("ORIGIN_INVALID");
  });
});
