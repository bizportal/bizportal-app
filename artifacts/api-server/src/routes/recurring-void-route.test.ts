import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  session: true,
  role: "owner",
  companyId: 1 as number | null,
  rows: [{ company_id: 1 }] as Array<{ company_id: number }>,
  queries: [] as Array<{sql: string; values: unknown[]}>,
  dbFailure: false,
}));

vi.mock("./dev-auth", () => ({
  createDevAuthRouter: () => express.Router(),
  getDevSession: () => null,
  isDevelopmentEnvironment: () => false,
  getProductionSession: () => state.session ? { id: "ci", email: "owner@example.test" } : null,
  getProductionUser: async () => state.session
    ? { id: "ci", email: "owner@example.test", role: state.role, companyId: state.companyId }
    : null,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      state.queries.push({ sql, values });
      if (state.dbFailure) throw Error("DISPOSABLE_PERMISSION_DENIED");
      if (sql.includes("FROM sport_center.sport_payments"))
        return { rows: state.rows, rowCount: state.rows.length };
      if (sql.includes("void_payment_for_recurring_replacement"))
        return { rows: [{ audit: { id: 9001 } }], rowCount: 1 };
      throw Error("UNEXPECTED_TEST_QUERY");
    }),
  },
}));
vi.mock("./health", async () => ({ default: (await import("express")).Router() }));
vi.mock("./companies", async () => ({ default: (await import("express")).Router() }));
vi.mock("./hrd-routes", async () => ({ default: (await import("express")).Router() }));
vi.mock("./payroll", async () => ({ default: (await import("express")).Router() }));
vi.mock("./bank-reconciliation", async () => ({ default: (await import("express")).Router() }));
vi.mock("./recon-classification", async () => ({ default: (await import("express")).Router() }));
vi.mock("./gmail-invoice-source", async () => ({ default: (await import("express")).Router() }));
vi.mock("./accounting", async () => ({ default: (await import("express")).Router() }));
vi.mock("./purchase-workflow", async () => ({ default: (await import("express")).Router() }));
vi.mock("./business-dashboard", async () => ({ default: (await import("express")).Router() }));
vi.mock("./sales-core", async () => ({ default: (await import("express")).Router() }));
vi.mock("./admin-realtime", async () => ({ default: (await import("express")).Router() }));
vi.mock("./legacy-read-parity", async () => ({ default: (await import("express")).Router() }));
vi.mock("./ai-review-read-parity", async () => ({ default: (await import("express")).Router() }));
vi.mock("./cash-bank-read-parity", async () => ({ default: (await import("express")).Router() }));
vi.mock("./advance-kasbon-readonly", async () => ({ default: (await import("express")).Router() }));
vi.mock("./accounting-settings-read-parity", async () => ({ default: (await import("express")).Router() }));
vi.mock("./fleet-intelligence", async () => ({ default: (await import("express")).Router() }));
vi.mock("./fleet-finance-integration", async () => ({ default: (await import("express")).Router() }));
vi.mock("./local-production-auth", async () => ({ default: (await import("express")).Router() }));

describe("actual recurring payment void HTTP route — fail-closed", () => {
  let server: Server;
  let base: string;
  const route = "/api/sport-center/payments/123/void";
  const post = (body: unknown = { companyId: "1", reason: "Synthetic audited reversal" }) =>
    fetch(base + route, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const { default: router } = await import("./index");
    const app = express();
    app.use((req, _res, next) => {
      req.log = { error: vi.fn() } as unknown as typeof req.log;
      next();
    });
    app.use(express.json());
    app.use("/api", router);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("NO_TEST_HTTP_LISTENER");
    base = "http://127.0.0.1:" + address.port;
  });
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("SPORT_CENTER_RECURRING_VOID_ENABLED", "");
    state.session = true; state.role = "owner"; state.companyId = 1;
    state.rows = [{ company_id: 1 }]; state.dbFailure = false;
    state.queries.length = 0;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not touch DB when feature is disabled by default", async () => {
    expect((await post()).status).toBe(503);
    expect(state.queries).toHaveLength(0);
  });
  it("requires an authenticated user", async () => {
    state.session = false;
    expect((await post()).status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });
  it("rejects unauthorized and cross-company actors before DB access", async () => {
    vi.stubEnv("SPORT_CENTER_RECURRING_VOID_ENABLED", "true");
    for (const role of ["finance", "admin", "staff", "accounting"]) {
      state.role = role;
      expect((await post()).status).toBe(403);
    }
    state.role = "owner"; state.companyId = 2;
    expect((await post()).status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
  it("requires explicit valid tenant scope and reason before DB access", async () => {
    expect((await post({ reason: "Synthetic audited reversal" })).status).toBe(400);
    expect((await post({ companyId: "all", reason: "Synthetic audited reversal" })).status).toBe(400);
    expect((await post({ companyId: "1", reason: "short" })).status).toBe(400);
    expect(state.queries).toHaveLength(0);
  });
  it("rejects DEV even when feature flag is requested", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("SPORT_CENTER_RECURRING_VOID_ENABLED", "true");
    expect((await post()).status).toBe(503);
    expect(state.queries).toHaveLength(0);
  });
  it("refuses missing or different-tenant payment without calling the financial writer", async () => {
    vi.stubEnv("SPORT_CENTER_RECURRING_VOID_ENABLED", "true");
    for (const rows of [[], [{ company_id: 2 }]]) {
      state.rows = rows;
      state.queries.length = 0;
      expect((await post()).status).toBe(404);
      expect(state.queries).toHaveLength(1);
      expect(state.queries[0].sql).toContain("company_id=$2");
    }
  });
  it("fails closed on database permission/RLS failure", async () => {
    vi.stubEnv("SPORT_CENTER_RECURRING_VOID_ENABLED", "true");
    state.dbFailure = true;
    expect((await post()).status).toBe(503);
    expect(state.queries).toHaveLength(1);
  });
  it("tests mocked positive lookup without touching any real payment", async () => {
    vi.stubEnv("SPORT_CENTER_RECURRING_VOID_ENABLED", "true");
    const result = await post();
    expect(result.status).toBe(200);
    expect(state.queries).toHaveLength(2);
    expect(state.queries[1].sql).toContain("void_payment_for_recurring_replacement");
  });
});
