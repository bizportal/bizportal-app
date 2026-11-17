import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  session: true,
  legacySession: false,
  actorRole: "super_admin",
  approverReady: false,
  dbAccess: 0,
}));

// Isolated HTTP route-registration checks only. The existing signed-session
// and real PostgreSQL gates cover separate authentication/transaction behavior.
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => process.env.APP_ENV === "development",
  getProductionSession: () => state.session ? { id: "synthetic-session" } : null,
  getProductionUser: async () => ({
    id: "synthetic-user", email: "test@example.invalid", role: state.actorRole,
    companyId: 1, firstName: null, lastName: null,
  }),
  getDevSession: () => state.legacySession ? ({
    id: "legacy-dev-user", email: "legacy@example.invalid", role: "super_admin",
    companyId: 1, firstName: null, lastName: null,
  }) : null,
}));
vi.mock("./payroll-db", () => ({
  getPayrollPool: () => { state.dbAccess++; throw Error("TEST_DB_ACCESS_DENIED"); },
  setPayrollCompanyScope: () => { state.dbAccess++; throw Error("TEST_DB_ACCESS_DENIED"); },
  payrollScopedQuery: async () => { state.dbAccess++; throw Error("TEST_DB_ACCESS_DENIED"); },
  payrollDedicatedEnabled: () => false,
}));
vi.mock("./payroll-prod-db", () => ({
  getPayrollPool: () => { state.dbAccess++; throw Error("TEST_PROD_DB_ACCESS_DENIED"); },
  setPayrollCompanyScope: () => { state.dbAccess++; throw Error("TEST_PROD_DB_ACCESS_DENIED"); },
  payrollScopedQuery: async () => { state.dbAccess++; throw Error("TEST_PROD_DB_ACCESS_DENIED"); },
  payrollProdDedicatedRequired: () => false,
  payrollReadOnlyReady: () => false,
}));
vi.mock("./payroll-dev-approval-db", () => ({
  devApprovalDedicatedEnabled: () => state.approverReady,
  getDevApprovalPool: () => { state.dbAccess++; throw Error("TEST_WRITER_ACCESS_DENIED"); },
  setDevApprovalCompanyScope: () => { state.dbAccess++; throw Error("TEST_WRITER_ACCESS_DENIED"); },
}));
vi.mock("./payroll-setup-readiness", () => ({
  registerPayrollSetupReadinessRoutes: () => {},
}));
vi.mock("./payroll-prod-connection-preflight", () => ({
  registerPayrollProdConnectionPreflightRoutes: () => {},
}));
vi.mock("@workspace/db", () => ({
  pool: { query: async () => { state.dbAccess++; throw Error("TEST_DB_ACCESS_DENIED"); } },
}));

async function withPayrollHttp(run: (root: string) => Promise<void>) {
  vi.resetModules();
  const { default: payrollRouter } = await import("./payroll");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { error: vi.fn() } as unknown as typeof req.log;
    next();
  });
  app.use("/api", payrollRouter);
  const server: Server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("TEST_HTTP_LISTENER_FAILED");
  try { await run("http://127.0.0.1:" + address.port + "/api/payroll/runs/32"); }
  finally { await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())); }
}

describe("strict DEV-only Payroll Super Admin approval route mount", () => {
  beforeEach(() => {
    state.session = true;
    state.legacySession = false;
    state.actorRole = "super_admin";
    state.approverReady = false;
    state.dbAccess = 0;
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("remains 404 when the mount feature flag is absent, even in DEV", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "");
    await withPayrollHttp(async root => {
      expect((await fetch(root + "/super-admin-approval-preview?companyId=1")).status).toBe(404);
      expect((await fetch(root + "/super-admin-approve?companyId=1", {method:"POST"})).status).toBe(404);
    });
    expect(state.dbAccess).toBe(0);
  });

  it("never mounts in PROD even if DEV flags and fake approver are present", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "true");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED", "true");
    state.approverReady = true;
    await withPayrollHttp(async root => {
      expect((await fetch(root + "/super-admin-approval-preview?companyId=1")).status).toBe(404);
      expect((await fetch(root + "/super-admin-approve?companyId=1", {method:"POST"})).status).toBe(404);
    });
    expect(state.dbAccess).toBe(0);
  });

  it("does not treat NODE_ENV=development as approval mount authorization", async () => {
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "true");
    state.approverReady = true;
    await withPayrollHttp(async root => {
      expect((await fetch(root + "/super-admin-approve?companyId=1", {method:"POST"})).status).toBe(404);
    });
    expect(state.dbAccess).toBe(0);
  });

  it("DEV mount alone exposes a fail-closed 501 but cannot approve", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "true");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED", "");
    await withPayrollHttp(async root => {
      const body = JSON.stringify({confirm:true,expectedDigest:"a".repeat(64),note:"Synthetic canary review"});
      const request = await fetch(root + "/super-admin-approve?companyId=1", {
        method:"POST",headers:{"Content-Type":"application/json"},body,
      });
      expect(request.status).toBe(501);
      expect((await fetch(root + "/super-admin-approval-preview?companyId=1")).status).toBe(503);
    });
    expect(state.dbAccess).toBe(0);
  });

  it("explicit approval flag still fails closed without the separate DEV DB login", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "true");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED", "true");
    await withPayrollHttp(async root => {
      const response = await fetch(root + "/super-admin-approve?companyId=1", {
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({confirm:true,expectedDigest:"a".repeat(64),note:"Synthetic canary review"}),
      });
      expect(response.status).toBe(501);
    });
    expect(state.dbAccess).toBe(0);
  });

  it("rejects unauthenticated requests before reaching even the approval canary", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "true");
    state.session = false;
    await withPayrollHttp(async root => {
      expect((await fetch(root + "/super-admin-approval-preview?companyId=1")).status).toBe(401);
    });
    expect(state.dbAccess).toBe(0);
  });

  it("rejects a valid legacy DEV test session without signed OTP, even if a writer is configured", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "true");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED", "true");
    state.session = false;
    state.legacySession = true;
    state.approverReady = true;
    await withPayrollHttp(async root => {
      const response = await fetch(root + "/super-admin-approve?companyId=1", {
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({confirm:true,expectedDigest:"a".repeat(64),note:"Synthetic canary review"}),
      });
      expect(response.status).toBe(401);
    });
    expect(state.dbAccess).toBe(0);
  });

  it("denies non-Super Admin even with the synthetic approver switch", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "true");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED", "true");
    state.actorRole = "finance";
    state.approverReady = true;
    await withPayrollHttp(async root => {
      expect((await fetch(root + "/super-admin-approve?companyId=1", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({confirm:true,expectedDigest:"a".repeat(64),note:"Synthetic canary review"}),
      })).status).toBe(403);
    });
    expect(state.dbAccess).toBe(0);
  });
});
