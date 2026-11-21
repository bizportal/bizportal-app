import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const m = vi.hoisted(() => ({
  connect: vi.fn(), query: vi.fn(), release: vi.fn(), poolQuery: vi.fn(),
  authenticated: true, signed: true, enabled: true,
}));
vi.mock("@workspace/db", () => ({
  pool: { connect: m.connect, query: m.poolQuery },
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


describe("CST DEV one-order synthetic customer provisioning", () => {
  const endpoint = () => fetch(root + "/api/sales/dev/qa-orders/108/attach-customer", { method: "POST" });
  const qaOrder = (changes: Record<string,unknown> = {}) => ({
    id: 108, company_id: 1, customer_id: null,
    doc_number: "QA-CST-DEV-OWNER-20261120-001",
    customer_name: "INTERNAL QA CST DEV — NO REAL CUSTOMER",
    status: "draft", invoice_status: "none", ...changes,
  });
  beforeEach(() => {
    process.env.APP_ENV = "development";
    process.env.BIZPORTAL_DEV_QA_ORDER108_CUSTOMER_SETUP = "true";
    m.signed = true;
    m.enabled = true;
    m.authenticated = true;
    m.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.sales_documents WHERE id=108")) return { rows: [qaOrder()], rowCount: 1 };
      if (sql.includes("INSERT INTO public.customers")) return { rows: [{ id: 911 }], rowCount: 1 };
      if (sql.includes("UPDATE public.sales_documents")) return { rows: [{ id: 108 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });
  it("is OFF unless explicitly enabled", async () => {
    delete process.env.BIZPORTAL_DEV_QA_ORDER108_CUSTOMER_SETUP;
    expect((await endpoint()).status).toBe(404);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("rejects unsigned session before DB access", async () => {
    m.signed = false;
    expect((await endpoint()).status).toBe(403);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("creates and links one synthetic customer with audit in same transaction", async () => {
    const response = await endpoint();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ salesDocumentId: 108, customerId: 911, synthetic: true });
    const queries = m.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.join("\n")).toContain("INSERT INTO public.customers");
    expect(queries.join("\n")).toContain("INSERT INTO erp_audit_logs");
    expect(queries).toContain("COMMIT");
    expect(queries.join("\n")).not.toMatch(/INSERT INTO (?:public\\.)?(?:journal|invoice|gl_)/i);
  });
  it("does not create duplicate customer on replay", async () => {
    m.query.mockImplementation(async (sql: string) =>
      sql.includes("FROM public.sales_documents WHERE id=108")
        ? { rows: [qaOrder({ customer_id: 911 })], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    expect((await endpoint()).status).toBe(409);
    expect(m.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.customers"))).toBe(false);
  });
  it("rejects unexpected QA document identity without inserting", async () => {
    m.query.mockImplementation(async (sql: string) =>
      sql.includes("FROM public.sales_documents WHERE id=108")
        ? { rows: [qaOrder({ doc_number: "REAL-SALES-108" })], rowCount: 1 }
        : { rows: [], rowCount: 1 });
    expect((await endpoint()).status).toBe(409);
    expect(m.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.customers"))).toBe(false);
  });
  it("rolls back customer creation if audit insertion fails", async () => {
    m.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.sales_documents WHERE id=108")) return { rows: [qaOrder()], rowCount: 1 };
      if (sql.includes("INSERT INTO public.customers")) return { rows: [{ id: 911 }], rowCount: 1 };
      if (sql.includes("UPDATE public.sales_documents")) return { rows: [{ id: 108 }], rowCount: 1 };
      if (sql.includes("INSERT INTO erp_audit_logs")) throw new Error("AUDIT_FAILURE");
      return { rows: [], rowCount: 1 };
    });
    expect((await endpoint()).status).toBe(503);
    const queries = m.query.mock.calls.map(([sql]) => String(sql));
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });
});

describe("QA #108 capability visibility", () => {
  const capability = () => fetch(root + "/api/sales/dev/qa-orders/108/customer-setup-capability");
  beforeEach(() => {
    m.signed = true;
    m.enabled = true;
    m.authenticated = true;
    process.env.APP_ENV = "development";
    process.env.BIZPORTAL_DEV_QA_ORDER108_CUSTOMER_SETUP = "true";
  });
  it("returns 404 when feature flag is OFF, without database access", async () => {
    delete process.env.BIZPORTAL_DEV_QA_ORDER108_CUSTOMER_SETUP;
    expect((await capability()).status).toBe(404);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("returns 403 with unsigned DEV session, without database access", async () => {
    m.signed = false;
    expect((await capability()).status).toBe(403);
    expect(m.connect).not.toHaveBeenCalled();
  });
  it("reveals one-time QA capability only to signed Super Admin", async () => {
    const res = await capability();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ available: true, documentId: 108, companyId: 1, syntheticOnly: true });
    expect(m.connect).not.toHaveBeenCalled();
  });
});

describe("CST-DEV QA Order #108 detail GET parity", () => {
  const detail = (id: string = "108") => fetch(root + "/api/sales/documents/" + id);
  beforeEach(() => {
    process.env.APP_ENV = "development";
    process.env.BIZPORTAL_DEV_QA_ORDER108_CUSTOMER_SETUP = "true";
    m.signed = true; m.authenticated = true; m.enabled = true;
    m.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.sales_documents")) {
        return { rows: [{
          id:108,doc_number:"QA-CST-DEV-OWNER-20261120-001",
          kind:"order",status:"draft",invoice_status:"none",
          delivery_status:"to_deliver",payment_status:"unpaid",
          customer_id:null,customer_name:"INTERNAL QA CST DEV — NO REAL CUSTOMER",
          total_amount:"100",tax_amount:"11",grand_total:"111",
          amount_paid:"0",created_at:new Date("2026-11-20T01:00:00Z"),
          updated_at:new Date("2026-11-20T01:00:00Z"),
        }], rowCount:1 };
      }
      if (sql.includes("FROM public.sales_document_lines")) {
        return { rows: [{id:901,document_id:108,product_id:null,
          name:"DEV QA",quantity:"1",unit_price:"100",subtotal:"100"}],rowCount:1 };
      }
      throw Error("UNEXPECTED_SQL");
    });
  });
  it("refuses other IDs without querying database", async () => {
    expect((await detail("107")).status).toBe(404);
    expect(m.poolQuery).not.toHaveBeenCalled();
  });
  it("does not expose detail when QA feature disabled", async () => {
    delete process.env.BIZPORTAL_DEV_QA_ORDER108_CUSTOMER_SETUP;
    expect((await detail()).status).toBe(404);
    expect(m.poolQuery).not.toHaveBeenCalled();
  });
  it("rejects unsigned DEV cookie before DB access", async () => {
    m.signed=false;
    expect((await detail()).status).toBe(403);
    expect(m.poolQuery).not.toHaveBeenCalled();
  });
  it("rejects when DB-signed Owner account not resolved", async () => {
    m.authenticated=false;
    expect((await detail()).status).toBe(403);
    expect(m.poolQuery).not.toHaveBeenCalled();
  });
  it("returns only QA 108 with expected detail and one line, read-only", async () => {
    const r=await detail();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const payload=await r.json();
    expect(payload).toMatchObject({id:108,companyId:undefined,docNumber:"QA-CST-DEV-OWNER-20261120-001",
      customerId:null,status:"draft",invoiceStatus:"none",grandTotal:111,
      lines:[{id:901,documentId:108,quantity:1,subtotal:100}]});
    expect(m.poolQuery).toHaveBeenCalledTimes(2);
    expect(m.poolQuery.mock.calls.map(([q])=>String(q)).join("\n")).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE|ALTER|CREATE)\b/i);
  });
  it("fails closed on unrelated/absent order, never returns another tenant's row", async () => {
    m.poolQuery.mockResolvedValue({rows:[],rowCount:0});
    expect((await detail()).status).toBe(404);
  });
});
