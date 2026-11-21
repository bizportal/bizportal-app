import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const m = vi.hoisted(() => ({
  connect: vi.fn(), query: vi.fn(), release: vi.fn(),
  authenticated: true, signed: true, enabled: true,
}));
vi.mock("@workspace/db", () => ({
  pool: { connect: m.connect, query: vi.fn() },
}));
vi.mock("./admin-auth", () => ({
  authenticateAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  isSignedOtpDevEnabled: () => m.enabled,
  getProductionSession: () => m.signed ? ({ id: "owner-1", email: "owner@test.dev" }) : null,
  getProductionUser: async () => m.authenticated
    ? ({ id: "owner-1", email: "owner@test.dev", role: "super_admin", companyId: 1 })
    : null,
}));

import router from "./sales-core";
let server: Server;
let root: string;

const doc = (overrides: Record<string, unknown> = {}) => ({
  id: 108, company_id: 1, customer_id: 22,
  kind: "order", status: "draft", invoice_status: "none", ...overrides,
});
const post = async (action: string = "confirm") => fetch(root + "/api/sales/documents/108/action", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action }),
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  root = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  m.signed = true;
  m.authenticated = true;
  m.enabled = true;
  process.env.APP_ENV = "development";
  process.env.BIZPORTAL_DEV_CANONICAL_SALES_CONFIRM_ENABLED = "true";
  m.connect.mockResolvedValue({ query: m.query, release: m.release });
  m.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM public.sales_documents WHERE id=$1 FOR UPDATE")) return { rows: [doc()], rowCount: 1 };
    if (sql.includes("FROM public.customers")) return { rows: [{ id: 22 }], rowCount: 1 };
    if (sql.includes("UPDATE public.sales_documents")) return { rows: [{ id: 108 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
});

describe("CST-DEV canonical Sales confirmation", () => {
  it("stays OFF by default", async () => {
    delete process.env.BIZPORTAL_DEV_CANONICAL_SALES_CONFIRM_ENABLED;
    expect((await post()).status).toBe(404);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("rejects unsigned DEV fallback", async () => {
    m.signed = false;
    expect((await post()).status).toBe(403);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("refuses invoice actions even when signed", async () => {
    expect((await post("mark_invoiced")).status).toBe(403);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("refuses order without customer ID and rolls back", async () => {
    m.query.mockImplementation(async (sql: string) =>
      sql.includes("FROM public.sales_documents WHERE id=$1 FOR UPDATE")
        ? { rows: [doc({ customer_id: null })], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    expect((await post()).status).toBe(422);
    expect(m.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(m.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE public.sales_documents"))).toBe(false);
  });
  it("refuses another company and never updates", async () => {
    m.query.mockImplementation(async (sql: string) =>
      sql.includes("FROM public.sales_documents WHERE id=$1 FOR UPDATE")
        ? { rows: [doc({ company_id: 3 })], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    expect((await post()).status).toBe(404);
  });
  it("rejects a company-mismatched customer", async () => {
    m.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.sales_documents WHERE id=$1 FOR UPDATE")) return { rows: [doc()], rowCount: 1 };
      if (sql.includes("FROM public.customers")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    expect((await post()).status).toBe(422);
  });
  it("refuses replay if already confirmed", async () => {
    m.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.sales_documents WHERE id=$1 FOR UPDATE")) return { rows: [doc({ status: "confirmed" })], rowCount: 1 };
      if (sql.includes("FROM public.customers")) return { rows: [{ id: 22 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    expect((await post()).status).toBe(409);
  });
  it("commits status and audit together, never creates invoice/journal", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "confirmed", invoiceIssued: false });
    const sql = m.query.mock.calls.map(([q]) => String(q)).join("\n");
    expect(sql).toContain("INSERT INTO erp_audit_logs");
    expect(sql).toContain("COMMIT");
    expect(sql).not.toMatch(/INSERT INTO (?:public\\.)?(?:journal|invoice|gl_)/i);
  });
  it("rolls back if mandatory audit fails", async () => {
    m.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.sales_documents WHERE id=$1 FOR UPDATE")) return { rows: [doc()], rowCount: 1 };
      if (sql.includes("FROM public.customers")) return { rows: [{ id: 22 }], rowCount: 1 };
      if (sql.includes("UPDATE public.sales_documents")) return { rows: [{ id: 108 }], rowCount: 1 };
      if (sql.includes("INSERT INTO erp_audit_logs")) throw new Error("AUDIT_UNAVAILABLE");
      return { rows: [], rowCount: 1 };
    });
    expect((await post()).status).toBe(503);
    expect(m.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(m.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });
});
