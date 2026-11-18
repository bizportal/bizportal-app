import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  actor: { role: "owner", companyId: 1 } as { role: string; companyId: number | null } | null,
  calls: [] as Array<{ sql: string; args: unknown[] }>,
  headerMissing: false,
}));

vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => process.env.APP_ENV === "development",
  getDevSession: () => state.actor,
  getProductionSession: () => null,
  getProductionUser: async () => null,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    query: async (sql: string, args: unknown[] = []) => {
      state.calls.push({ sql, args });
      if (sql.includes("with reconciled_vendor_invoice_payments as")) {
        return { rowCount: 1, rows: [{
          id: 31, invoice_number: "VI-DEV-31", vendor_invoice_ref: "INV-31",
          supplier_id: 2, supplier_name: "Synthetic supplier",
          grand_total: "120000.00", tax_amount: "0.00",
          due_date: "2026-11-20", withholding_tax_amount: "20000.00",
          reconciled_amount_paid: "50000.00",
        }] };
      }
      if (sql.includes("from public.bank_disbursement_items item")) {
        return { rowCount: 1, rows: [{
          id: 21, seq: 1, transaction_type: "supplier_payment",
          account_id: 4, description: "Synthetic invoice", amount: "125000.00",
          notes: null, purchase_document_id: null, wht_amount: "0.00",
          wht_account_id: null, party_name: "Synthetic vendor",
        }] };
      }
      if (state.headerMissing) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{
        id: 9, company_id: 1, disbursement_number: "BD-TEST-9", journal_id: 7,
        date: "2026-11-16", ref: "DEV-ONLY", memo: null,
        total_amount: "125000.00", status: "posted", entry_id: 19,
        created_at: "2026-11-16T00:00:00.000Z", attachment_url: null,
        counterparty_name: "Synthetic vendor", counterparty_type: "vendor",
        counterparty_id: null, source_module: null, expense_id: null,
        source_number: null,
      }] };
    },
  },
}));

import router from "./accounting";

describe("Bank Disbursement DEV read-only HTTP parity", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use("/api", router);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("missing test port");
    base = "http://127.0.0.1:" + address.port;
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("BIZPORTAL_DEV_BD_READONLY_ENABLED", "true");
    state.actor = { role: "owner", companyId: 1 };
    state.calls.length = 0;
    state.headerMissing = false;
  });
  afterEach(() => vi.unstubAllEnvs());

  const get = (path = "/accounting/bank-disbursements?company=1") =>
    fetch(base + "/api" + path);

  it("is disabled by default and under production, without querying database", async () => {
    vi.stubEnv("BIZPORTAL_DEV_BD_READONLY_ENABLED", "");
    expect((await get()).status).toBe(404);
    vi.stubEnv("BIZPORTAL_DEV_BD_READONLY_ENABLED", "true");
    vi.stubEnv("APP_ENV", "production");
    expect((await get()).status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });

  it("rejects anonymous and unauthorized roles before database reads", async () => {
    state.actor = null;
    expect((await get()).status).toBe(401);
    state.actor = { role: "staff", companyId: 1 };
    expect((await get()).status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it("rejects company crossover and an unscoped actor", async () => {
    expect((await get("/accounting/bank-disbursements?company=2")).status).toBe(400);
    state.actor = { role: "owner", companyId: null };
    expect((await get("/accounting/bank-disbursements")).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("requires a verified session company even when URL supplies one", async () => {
    state.actor = { role: "owner", companyId: null };
    for (const endpoint of [
      "/accounting/bank-disbursements?company=1",
      "/accounting/bank-disbursements/9?company=1",
      "/accounting/bank-disbursements/vendor-invoices/outstanding?company=1",
    ]) {
      expect((await get(endpoint)).status).toBe(400);
    }
    expect(state.calls).toHaveLength(0);
  });

  it("rejects invalid limits without database calls", async () => {
    expect((await get("/accounting/bank-disbursements?company=1&limit=101")).status).toBe(400);
    expect((await get("/accounting/bank-disbursements?company=1&limit=0")).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("returns only company-scoped list data with a parameterized bounded SQL query", async () => {
    const response = await get("/accounting/bank-disbursements?company=1&limit=10");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject([{ id: 9, disbursementNumber: "BD-TEST-9",
      totalAmount: 125000, counterpartyName: "Synthetic vendor" }]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args).toEqual([1, 10]);
    expect(state.calls[0].sql).toContain("where company_id = $1");
    expect(state.calls[0].sql).toContain("limit $2");
  });

  it("does not provide a financial writer or void route", async () => {
    expect((await fetch(base + "/api/accounting/bank-disbursements", {
      method: "POST",
    })).status).toBe(404);
    expect((await fetch(base + "/api/accounting/bank-disbursements/9/void", {
      method: "POST",
    })).status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });
  it("returns detail and items under matching company, without writes", async () => {
    const response = await get("/accounting/bank-disbursements/9?company=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      id: 9, companyId: 1, disbursementNumber: "BD-TEST-9",
      items: [{ id: 21, transactionType: "supplier_payment", amount: 125000 }],
      entry: null,
    });
    expect(state.calls).toHaveLength(2);
    expect(state.calls.map(x => x.args)).toEqual([[9, 1], [9, 1]]);
    expect(state.calls[1].sql).toContain("bd.company_id = $2");
  });

  it("rejects cross-company detail, invalid id, and missing record", async () => {
    expect((await get("/accounting/bank-disbursements/9?company=2")).status).toBe(400);
    expect((await get("/accounting/bank-disbursements/garbage?company=1")).status).toBe(400);
    expect(state.calls).toHaveLength(0);
    state.headerMissing = true;
    expect((await get("/accounting/bank-disbursements/9?company=1")).status).toBe(404);
    expect(state.calls).toHaveLength(1);
  });

  it("shows outstanding Vendor Invoice only from reconciled allocation, without permitting payment", async () => {
    const response = await get("/accounting/bank-disbursements/vendor-invoices/outstanding?company=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      reviewOnly: true, canPay: false, coverage: "vendor_invoice_only",
      invoices: [{
        id: 31, source: "vendor_invoice", grandTotal: 120000,
        amountPaid: 50000, outstanding: 70000, reviewOnly: true, canPay: false,
      }],
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args).toEqual([1]);
    expect(state.calls[0].sql).toContain("reconciled_vendor_invoice_payments");
    expect(state.calls[0].sql).toContain("rvip.company_id = vi.company_id");
    expect(state.calls[0].sql).not.toContain("vi.amount_paid");
  });

  it("rejects unscoped or cross-company outstanding reads", async () => {
    expect((await get("/accounting/bank-disbursements/vendor-invoices/outstanding?company=2")).status).toBe(400);
    state.actor = { role: "finance", companyId: null };
    expect((await get("/accounting/bank-disbursements/vendor-invoices/outstanding")).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("keeps outstanding review GET disabled by default and denies POST", async () => {
    vi.stubEnv("BIZPORTAL_DEV_BD_READONLY_ENABLED", "");
    expect((await get("/accounting/bank-disbursements/vendor-invoices/outstanding?company=1")).status).toBe(404);
    vi.stubEnv("BIZPORTAL_DEV_BD_READONLY_ENABLED", "true");
    expect((await fetch(base + "/api/accounting/bank-disbursements/vendor-invoices/outstanding?company=1", {
      method: "POST",
    })).status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });

});
