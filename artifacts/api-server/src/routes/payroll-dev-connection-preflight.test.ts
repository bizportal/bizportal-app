import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { registerPayrollProdConnectionPreflightRoutes } from "./payroll-prod-connection-preflight";

const state = vi.hoisted(() => ({
  signedMode: true, signedSession: true, verified: true, authError: false,
  configured: false, configError: false, queryError: false,
  actorRole: "super_admin", actorCompany: null as number | null, companyId: 1,
  actorId: "synthetic-super-admin", signedActorId: "synthetic-super-admin",
  dbRole: "bizportal_payroll_dev", sessionRole: "bizportal_payroll_dev",
  dbScope: "1", readOnly: "on", restricted: true,
  calls: [] as Array<{ companyId: number; sql: string; args: unknown[] }>,
  sharedCalls: 0, signedChecks: 0,
}));
vi.mock("./dev-auth", () => ({
  isSignedOtpDevEnabled: () => state.signedMode,
  getProductionSession: () => {
    state.signedChecks++;
    return state.signedSession ? { id: state.signedActorId, email: "admin@example.test" } : null;
  },
  getProductionUser: async () => {
    if (state.authError) throw Error("postgresql://bad:password@secret.invalid");
    return state.verified ? {
      id: state.signedActorId, email: "admin@example.test", role: state.actorRole,
      companyId: state.actorCompany, firstName: null, lastName: null,
    } : null;
  },
}));
vi.mock("./payroll-db", () => ({
  payrollDedicatedEnabled: () => {
    if (state.configError) throw Error("postgresql://bad:password@secret.invalid");
    return state.configured;
  },
  payrollScopedQuery: async (companyId: number, sql: string, args: unknown[]) => {
    state.calls.push({ companyId, sql, args });
    if (state.queryError) throw Error("postgresql://bad:password@secret.invalid");
    return { rowCount: 1, rows: [{
      dbRole: state.dbRole, sessionRole: state.sessionRole, companyScope: state.dbScope,
      txReadOnly: state.readOnly, restrictedRole: state.restricted,
      visibleRuns: "1", visibleProfiles: "0",
    }] };
  },
}));
vi.mock("./payroll-prod-db", () => ({
  payrollReadOnlyReady: () => false,
  payrollProdSharedReadOnlyEnabled: () => false,
  payrollScopedQuery: async () => { state.sharedCalls++; throw Error("PROD_POOL_NEVER_ALLOWED"); },
}));
vi.mock("@workspace/db", () => ({
  pool: { query: async () => { state.sharedCalls++; throw Error("SHARED_POOL_NEVER_ALLOWED"); } },
}));

describe("existing Payroll connection-preflight: DEV signed-only read-only diagnostic", () => {
  let server: Server, root: string;
  beforeAll(async () => {
    const router = Router();
    router.use((req, _res, next) => {
      const scoped = req as typeof req & {
        payrollActor?: { id: string; email: string; role: string; companyId: number | null };
        payrollCompanyId?: number;
      };
      scoped.payrollCompanyId = state.companyId;
      scoped.payrollActor = { id: state.actorId, email: "admin@example.test",
        role: state.actorRole, companyId: state.actorCompany };
      next();
    });
    registerPayrollProdConnectionPreflightRoutes(router);
    const app = express(); app.use("/api", router);
    server = createServer(app);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("NO_TEST_HTTP_PORT");
    root = "http://127.0.0.1:" + address.port;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_CONNECTION_PREFLIGHT_ENABLED", "true");
    Object.assign(state, {
      signedMode: true, signedSession: true, verified: true, authError: false,
      configured: false, configError: false, queryError: false,
      actorRole: "super_admin", actorCompany: null, companyId: 1,
      actorId: "synthetic-super-admin", signedActorId: "synthetic-super-admin",
      dbRole: "bizportal_payroll_dev", sessionRole: "bizportal_payroll_dev",
      dbScope: "1", readOnly: "on", restricted: true,
      sharedCalls: 0, signedChecks: 0,
    });
    state.calls.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());
  const get = (companyId = "1") => fetch(
    root + "/api/payroll/connection-preflight?companyId=" + companyId);
  const code = async (r: Response) => (await r.json() as { code: string }).code;

  it("defaults OFF in DEV, no authentication or database work", async () => {
    vi.stubEnv("PAYROLL_DEV_CONNECTION_PREFLIGHT_ENABLED", "");
    expect((await get()).status).toBe(404);
    expect(state.signedChecks).toBe(0);
    expect(state.calls).toHaveLength(0);
  });
  it("cannot activate in unknown APP_ENV", async () => {
    vi.stubEnv("APP_ENV", "staging");
    expect((await get()).status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });
  it("requires configured signed-OTP mode, not a legacy DEV cookie", async () => {
    state.signedMode = false;
    expect(await code(await get())).toBe("PAYROLL_DEV_SIGNED_OTP_NOT_READY");
    state.signedMode = true; state.signedSession = false;
    expect((await get()).status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });
  it("refuses revoked or unverifiable signed accounts without touching Payroll DB", async () => {
    state.verified = false;
    expect((await get()).status).toBe(403);
    state.verified = true; state.authError = true;
    const response = await get(); expect(response.status).toBe(503);
    expect(await code(response)).toBe("PAYROLL_DEV_SESSION_VERIFICATION_UNAVAILABLE");
    expect(state.calls).toHaveLength(0);
  });
  it("requires matching signed Super Admin identity and selected company", async () => {
    state.actorRole = "owner";
    expect((await get()).status).toBe(403);
    state.actorRole = "super_admin"; state.actorId = "different-user";
    expect((await get()).status).toBe(403);
    state.actorId = "synthetic-super-admin"; state.companyId = 3;
    expect((await get("1")).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });
  it("diagnoses missing dedicated reader credential without trying any shared pool", async () => {
    const response = await get(); expect(response.status).toBe(503);
    expect(await code(response)).toBe("PAYROLL_DEV_DEDICATED_NOT_CONFIGURED");
    expect(state.calls).toHaveLength(0); expect(state.sharedCalls).toBe(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("redacts malformed dedicated URI and SQL errors", async () => {
    state.configError = true;
    const invalid = await get(); expect(invalid.status).toBe(503);
    expect((await invalid.text())).not.toMatch(/password|postgresql:|secret.invalid/);
    state.configError = false; state.configured = true; state.queryError = true;
    const failure = await get(); expect(failure.status).toBe(503);
    expect(await code(failure)).toBe("PAYROLL_DEV_DATABASE_READINESS_FAILED");
    expect(state.sharedCalls).toBe(0);
  });
  it.each([
    ["other login", { dbRole: "postgres" }],
    ["session switched role", { sessionRole: "postgres" }],
    ["foreign company scope", { dbScope: "3" }],
    ["missing read-only transaction", { readOnly: "off" }],
    ["privileged role", { restricted: false }],
  ])("rejects %s even with a configured URL", async (_name, mutation) => {
    state.configured = true;
    Object.assign(state, mutation);
    const response = await get(); expect(response.status).toBe(503);
    expect(await code(response)).toBe("PAYROLL_DEV_ROLE_SCOPE_INVALID");
    expect(state.sharedCalls).toBe(0);
  });
  it("verifies only a signed read-only company-scoped DEV role, no salary data exposed", async () => {
    state.configured = true;
    const response = await get(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true, readOnly: true, dedicatedConnectionVerified: true,
      companyScopeVerified: true, roleVerified: true, diagnosticOnly: true,
      rlsPolicySemanticsVerified: false,
      canPay: false, canApprove: false, canPostJournal: false, canWriteKasbon: false,
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.companyId).toBe(1);
    expect(state.calls[0]?.sql).toContain("current_setting('transaction_read_only')");
    expect(state.calls[0]?.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    expect(state.sharedCalls).toBe(0);
  });
  it("honors an explicitly selected second company without fallback", async () => {
    state.configured = true; state.companyId = 3; state.dbScope = "3";
    const response = await get("3"); expect(response.status).toBe(200);
    expect(state.calls[0]?.companyId).toBe(3);
    expect(state.sharedCalls).toBe(0);
  });
});
