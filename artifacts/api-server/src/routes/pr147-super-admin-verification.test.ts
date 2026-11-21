import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  signedEnabled: true,
  session: null as null | { id: string; email: string },
  user: null as null | { role: string; companyId: number | null },
  failDb: false,
  queries: [] as Array<{ company: number; sql: string }>,
}));

vi.mock("./dev-auth", () => ({
  isSignedOtpDevEnabled: () => state.signedEnabled,
  getProductionSession: () => state.session,
  getProductionUser: async () => state.user,
}));
vi.mock("../lib/bankSheetScopedReader", () => ({
  getDevBankSheetReaderFromConfiguredSource: async (company: number) => ({
    query: async (sql: string) => {
      state.queries.push({ company, sql });
      if (state.failDb) throw new Error("private DSN / SECRET MUST NOT LEAK");
      if (sql.includes("current_user AS actor")) {
        const role = company === 1 ? "bizportal_finance_cst_login_dev" : "bizportal_finance_diva_login_dev";
        return { rows: [{
          actor: role, session_actor: role, sheet_rls: true,
          bank_rls: true, can_read: true, can_write: false,
        }] };
      }
      return { rows: company === 1
        ? [{ company_id: 1 }, { company_id: 1 }]
        : [] };
    },
  }),
}));

import router from "./pr147-super-admin-verification";

describe("PR147 real signed Super Admin opt-in verification", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use("/api", router);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("MISSING_TEST_PORT");
    base = `http://127.0.0.1:${address.port}/api/pr147/verify-super-admin`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PR147_SIGNED_VERIFY_ENABLED_DEV", "true");
    state.signedEnabled = true;
    state.session = { id: "real-session-shape", email: "admin@example.test" };
    state.user = { role: "super_admin", companyId: null };
    state.failDb = false;
    state.queries.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not exist in PROD or without opt-in", async () => {
    vi.stubEnv("APP_ENV", "production");
    expect((await fetch(base)).status).toBe(404);
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PR147_SIGNED_VERIFY_ENABLED_DEV", "");
    expect((await fetch(base)).status).toBe(404);
    expect(state.queries).toHaveLength(0);
  });
  it("requires genuine signed OTP and never uses legacy DEV login", async () => {
    state.signedEnabled = false;
    expect((await fetch(base)).status).toBe(503);
    state.signedEnabled = true;
    state.session = null;
    expect((await fetch(base)).status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });
  it("refuses non-admin and company-bound users", async () => {
    state.user = { role: "finance", companyId: null };
    expect((await fetch(base)).status).toBe(403);
    state.user = { role: "super_admin", companyId: 1 };
    expect((await fetch(base)).status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
  it("gives non-sensitive evidence for verified signed owner and read-only RLS", async () => {
    const response = await fetch(base);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload.code).toBe("PR147_SIGNED_SUPER_ADMIN_READER_PASS");
    expect(payload.companies).toEqual([
      { companyId: 1, status: "PASS", configCount: 2 },
      { companyId: 3, status: "PASS", configCount: 0 },
    ]);
    expect(payload.productionCutoverApproved).toBe(false);
    expect(state.queries).toHaveLength(4);
    expect(state.queries.every(query => query.sql.trim().toUpperCase().startsWith("SELECT"))).toBe(true);
  });
  it("fails closed without leaking secret or DB details", async () => {
    state.failDb = true;
    const response = await fetch(base);
    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).not.toContain("SECRET MUST NOT LEAK");
    expect(JSON.parse(raw).productionCutoverApproved).toBe(false);
  });
});
