import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const { access, queries, scopedQueries, financeReadOnly } = vi.hoisted(() => ({
  access: {
    actor: null as null | { id: string; email: string; role: string; companyId: number | null },
    dev: true,
    otpEnabled: false,
    signedSession: false,
    selectedCompany: null as number | null,
    approvedGlobal: true,
    companyActive: true,
  },
  queries: vi.fn(async (_statement: string, _params?: unknown[]) => ({ rows: [] as Array<Record<string, unknown>> })),
  scopedQueries: vi.fn(async (_statement: unknown) => ({ rows: [] })),
  financeReadOnly: vi.fn(),
}));

vi.mock("@workspace/db", () => ({ pool: { query: queries }, withMarketplaceFinanceDevReadOnlyTransaction: financeReadOnly }));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => access.dev,
  isSignedDevAuthEnabled: () => access.otpEnabled,
  getFinanceCompanyScope: () => access.selectedCompany,
  isApprovedFinanceGlobalSuperAdmin: () => access.approvedGlobal,
  isApprovedFinanceGlobalCompany: (id: number) => [1, 3].includes(id),
  getProductionSession: () => access.signedSession
    ? { id: "signed-test", email: "verified@example.invalid", expiresAt: Date.now() + 60_000 }
    : null,
}));
vi.mock("./admin-auth", () => ({
  authenticateAdmin: (req: any, res: any, next: () => void) => {
    if (!access.actor) return res.status(401).json({ error: "Unauthorized" });
    req.adminUser = access.actor;
    next();
  },
}));

import router from "./customer-ar-match-preview";

const companyFlag = "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV";
const originalCompanyFlag = process.env[companyFlag];
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = { error: () => {} };
    next();
  });
  app.use("/api", router);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}/api/sales/customer-invoices/auto-match-preview`;
});

afterAll(async () => {
  if (originalCompanyFlag === undefined) delete process.env[companyFlag];
  else process.env[companyFlag] = originalCompanyFlag;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  access.dev = true;
  access.actor = null;
  access.otpEnabled = false;
  access.signedSession = false;
  queries.mockReset().mockImplementation(async (statement, params) => ({
    rows: statement.includes("public.companies") && access.companyActive ? [{ id: params?.[0] }] : [],
  }));
  access.companyActive = true;
  access.selectedCompany = null;
  access.approvedGlobal = true;
  delete process.env[companyFlag];
  scopedQueries.mockReset().mockResolvedValue({ rows: [] });
  financeReadOnly.mockReset().mockImplementation(async (_companyId, work) => work({ execute: scopedQueries }));
});

async function check(companyId: number) {
  const response = await fetch(`${base}?company_id=${companyId}`);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe("DEV Customer AR HTTP tenant isolation", () => {
  it("denies finance without a verified company binding even in DEV", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "finance", companyId: null };
    const result = await check(2);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("COMPANY_SCOPE_MISSING");
    expect(queries).not.toHaveBeenCalled();
  });

  it("denies an ordinary admin trying another company without reading rows", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "admin", companyId: 1 };
    const result = await check(2);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("COMPANY_SCOPE_MISMATCH");
    expect(queries).not.toHaveBeenCalled();
  });

  it("allows a company-scoped finance reader but creates no settlement", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "finance", companyId: 1 };
    const result = await check(1);
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe("read_only_preview");
    expect(result.body.autoApproveEnabled).toBe(false);
    expect(result.body.autoPostEnabled).toBe(false);
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("allows explicitly privileged owner to select a company", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "owner", companyId: null };
    const result = await check(2);
    expect(result.status).toBe(200);
    expect(result.body.companyId).toBe(2);
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("blocks legacy DEV-only cookie for cross-company AR when signed OTP is on", async () => {
    access.otpEnabled = true;
    access.actor = { id: "a", email: "test@invalid.example", role: "super_admin", companyId: 1 };
    const result = await check(2);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("SIGNED_GLOBAL_ADMIN_REQUIRED");
    access.actor = { id: "b", email: "test@invalid.example", role: "owner", companyId: null };
    const global = await check(1);
    expect(global.status).toBe(403);
    expect(global.body.code).toBe("SIGNED_GLOBAL_ADMIN_REQUIRED");
    expect(queries).not.toHaveBeenCalled();
  });

  it("allows verified OTP global reader and same-company legacy reader without posting", async () => {
    access.otpEnabled = true;
    access.actor = { id: "a", email: "test@invalid.example", role: "owner", companyId: null };
    access.signedSession = true;
    const verified = await check(2);
    expect(verified.status).toBe(200);
    expect(verified.body.autoApproveEnabled).toBe(false);
    expect(verified.body.autoPostEnabled).toBe(false);
    expect(queries).toHaveBeenCalledTimes(2);

    queries.mockClear();
    access.signedSession = false;
    access.actor = { id: "b", email: "test@invalid.example", role: "owner", companyId: 1 };
    const scoped = await check(1);
    expect(scoped.status).toBe(200);
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("rejects anonymous callers and keeps PROD route inaccessible", async () => {
    expect((await check(1)).status).toBe(401);
    access.actor = { id: "a", email: "test@invalid.example", role: "owner", companyId: null };
    access.dev = false;
    expect((await check(1)).status).toBe(404);
    expect(queries).not.toHaveBeenCalled();
  });
});


describe("Customer AR dedicated company read-only routing", () => {
  beforeEach(() => {
    process.env[companyFlag] = "true";
    access.otpEnabled = true;
    access.signedSession = true;
    access.actor = { id: "cst", email: "cst@example.invalid", role: "finance", companyId: 1 };
  });

  it("routes CST reads through one read-only company session with bound parameters", async () => {
    const response = await check(1);
    expect(response.status).toBe(200);
    expect(response.body.autoPostEnabled).toBe(false);
    expect(financeReadOnly).toHaveBeenCalledTimes(1);
    expect(financeReadOnly.mock.calls[0][0]).toBe(1);
    expect(scopedQueries).toHaveBeenCalledTimes(2);
    for (const [statement] of scopedQueries.mock.calls) {
      const query = new PgDialect().sqlToQuery(statement as any);
      expect(query.params).toEqual([1]);
      expect(query.sql).toContain("$1");
    }
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toContain("public.companies");
  });

  it("routes DIVA through its own company identity", async () => {
    access.actor = { id: "diva", email: "diva@example.invalid", role: "finance", companyId: 3 };
    expect((await check(3)).status).toBe(200);
    expect(financeReadOnly.mock.calls[0][0]).toBe(3);
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toContain("public.companies");
  });

  it("denies unsigned same-company cookies and unsupported companies before any DB access", async () => {
    access.signedSession = false;
    expect((await check(1)).body.code).toBe("CUSTOMER_AR_SIGNED_SESSION_REQUIRED");
    access.signedSession = true;
    access.actor!.companyId = 2;
    expect((await check(2)).body.code).toBe("CUSTOMER_AR_COMPANY_NOT_ENABLED");
    expect(financeReadOnly).not.toHaveBeenCalled();
    expect(queries).not.toHaveBeenCalled();
  });

  it("does not let even a company-bound Super Admin widen scope through a query", async () => {
    access.actor!.role = "super_admin";
    expect((await check(3)).body.code).toBe("CUSTOMER_AR_SIGNED_COMPANY_SCOPE_REQUIRED");
    expect(financeReadOnly).not.toHaveBeenCalled();
    expect(queries).not.toHaveBeenCalled();
  });

  it("requires the approved global Super Admin's signed Finance company selection", async () => {
    access.actor = { id: "global", email: "global@example.invalid", role: "super_admin", companyId: null };
    expect((await check(3)).status).toBe(403);
    access.selectedCompany = 3;
    expect((await check(1)).status).toBe(403);
    expect((await check(3)).status).toBe(200);
    expect(financeReadOnly.mock.calls[0][0]).toBe(3);
    access.approvedGlobal = false;
    expect((await check(3)).status).toBe(403);
    expect(financeReadOnly).toHaveBeenCalledTimes(1);
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toContain("public.companies");
  });

  it("rejects a deactivated company before reading any financial rows", async () => {
    access.companyActive = false;
    const response = await check(1);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("CUSTOMER_AR_COMPANY_UNAVAILABLE");
    expect(financeReadOnly).not.toHaveBeenCalled();
    expect(scopedQueries).not.toHaveBeenCalled();
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toContain("public.companies");
  });

  it("returns 503 on a restricted-session failure without global-pool fallback", async () => {
    financeReadOnly.mockRejectedValueOnce(new Error("restricted role unavailable"));
    const response = await check(1);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("CUSTOMER_AR_PREVIEW_UNAVAILABLE");
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toContain("public.companies");
  });
});
