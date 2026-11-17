import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const database = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { connect: database.connect } }));
import router from "../routes/fleet-finance-integration";

let server: Server;
let base: string;
const token = "isolated-fleet-finance-company-http-test";
const payment = { companyId: 3, sourceCompanyId: 1, paymentId: 44, amount: 100000,
  driverName: "DEV QA", paymentDate: "2026-11-17", referenceNo: "QA44" };

async function request(path: string, method = "GET", body?: unknown, key = "fleet-cash-payment:1:44", bearer = token) {
  const response = await fetch(base + path, {
    method,
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json", "idempotency-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations/fleet", router);
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing isolated HTTP port");
  base = "http://127.0.0.1:" + address.port + "/api/integrations/fleet";
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("FLEET_FINANCE_SERVICE_TOKEN", token);
  vi.stubEnv("FLEET_FINANCE_COMPANY_MAP", '{"1":3}');
  vi.stubEnv("FLEET_FINANCE_WRITE_ENABLED", "true");
  database.connect.mockResolvedValue({ query: database.query, release: database.release });
  database.query.mockImplementation(async (sql: string) => sql.includes("FROM public.companies") ?
    { rows: [{ id: 3 }], rowCount: 1 } : { rows: [], rowCount: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("Fleet Finance source company 1 to PT Diva Servis company 3", () => {
  it("requires an authenticated dedicated service before considering a company", async () => {
    const result = await request("/companies/3/accounting-settings?sourceCompanyId=1", "GET", undefined, undefined, "invalid");
    expect(result.status).toBe(401);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("keeps all writes disabled unless explicitly enabled on the receiving service", async () => {
    vi.stubEnv("FLEET_FINANCE_WRITE_ENABLED", "");
    const result = await request("/cash-payments", "POST", payment);
    expect(result).toMatchObject({ status: 503, body: { code: "FLEET_FINANCE_WRITES_DISABLED", writeEnabled: false } });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each(["", "{}", "[]", '{"1":"3"}', '{"1":3,"2":0}'])("rejects absent or invalid server company mapping %s", async (map) => {
    vi.stubEnv("FLEET_FINANCE_COMPANY_MAP", map);
    expect((await request("/companies/3/accounting-settings?sourceCompanyId=1")).status).toBe(503);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each(["/companies/1/accounting-settings?sourceCompanyId=1", "/companies/3/accounting-settings?sourceCompanyId=2", "/companies/3/accounting-settings"])("rejects unmapped read scope before database access: %s", async (path) => {
    expect((await request(path)).status).toBe(403);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("reads only DSV settings and includes both source and accounting identities", async () => {
    database.query.mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ fleet_cash_account_id: 49187, fleet_driver_receivable_account_id: 49191, journal_id: 20 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 49187 }, { id: 49191 }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ id: 20 }], rowCount: 1 });
    const result = await request("/companies/3/accounting-settings?sourceCompanyId=1");
    expect(result).toEqual({ status: 200, body: { companyId: 3, sourceCompanyId: 1, fleetCashAccountId: 49187, fleetDriverReceivableAccountId: 49191, journalId: 20 } });
    expect(database.query.mock.calls.map((call) => call[1])).toEqual([[3], [3], [3, [49187, 49191]], [20, 3]]);
    expect(database.release).toHaveBeenCalledOnce();
  });

  it("rejects configured journal that is not active in DSV", async () => {
    database.query.mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ fleet_cash_account_id: 49187, fleet_driver_receivable_account_id: 49191, journal_id: 99 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 49187 }, { id: 49191 }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect((await request("/companies/3/accounting-settings?sourceCompanyId=1")).status).toBe(409);
  });

  it("cannot redirect a payment to CST by changing its body", async () => {
    expect((await request("/cash-payments", "POST", { ...payment, companyId: 1 })).status).toBe(403);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("cannot change settings for another company using a contradictory body", async () => {
    expect((await request("/companies/3/accounting-settings", "PUT", {
      companyId: 1, sourceCompanyId: 1, fleetCashAccountId: 49187, fleetDriverReceivableAccountId: 49191, journalId: 20,
    })).status).toBe(403);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects header COAs even if their other flags claim they can be posted", async () => {
    database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [
        { id: 49188, type: "asset", is_active: true, is_postable: true, is_header: true, status: "ACTIVE" },
        { id: 49191, type: "asset", is_active: true, is_postable: true, is_header: false, status: "ACTIVE" },
      ], rowCount: 2 });
    expect((await request("/companies/3/accounting-settings", "PUT", {
      companyId: 3, sourceCompanyId: 1, fleetCashAccountId: 49188, fleetDriverReceivableAccountId: 49191, journalId: 20,
    })).status).toBe(409);
    expect(database.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(database.query.mock.calls.some((call) => /INSERT|UPDATE/.test(call[0]))).toBe(false);
  });

  it("cannot post a nonexistent or another-company payment", async () => {
    const result = await request("/cash-payments", "POST", payment);
    expect(result.status).toBe(409);
    expect(database.query.mock.calls.some((call) => /INSERT INTO public.accounting_entries/.test(call[0]))).toBe(false);
    expect(database.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it.each([{ amount: 100001 }, { paymentDate: "2026-11-16" }, { driverName: "Different" }, { referenceNo: "Different" }])("rejects payload changes against the committed source: %j", async (change) => {
    database.query.mockImplementation(async (sql: string) => sql.includes("FROM public.companies") ? { rows: [{ id: 3 }], rowCount: 1 } : ({ rows: sql.includes("FROM public.fleet_cash_payments") ? [{
      id: 44, company_id: 1, amount: "100000.00", driver_name: "DEV QA", payment_date: "2026-11-17",
      reference_no: "QA44", status: "confirmed", accounting_entry_id: null,
    }] : [], rowCount: sql.includes("FROM public.fleet_cash_payments") ? 1 : 0 }));
    expect((await request("/cash-payments", "POST", { ...payment, ...change })).status).toBe(409);
    expect(database.query.mock.calls.some((call) => /INSERT INTO public.accounting_entries/.test(call[0]))).toBe(false);
  });

  it.each([true, false, "100000", null, 0, -1, 1.001])("rejects nonnumeric or imprecise request amount %j before database access", async (amount) => {
    expect((await request("/cash-payments", "POST", { ...payment, amount })).status).toBe(400);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects an inactive destination even if mapping is configured", async () => {
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await request("/companies/3/accounting-settings?sourceCompanyId=1")).status).toBe(409);
    expect(database.query).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a historical payment whose journal belongs to another company", async () => {
    database.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.companies")) return { rows: [{ id: 3 }], rowCount: 1 };
      if (sql.includes("FROM public.fleet_cash_payments")) return { rows: [{
        id: 44, company_id: 1, amount: "100000.00", driver_name: "DEV QA", payment_date: "2026-11-17",
        reference_no: "QA44", status: "confirmed", accounting_entry_id: null,
      }], rowCount: 1 };
      if (sql.includes("FROM public.accounting_entries")) return { rows: [{
        id: 200, company_id: 3, status: "posted", entry_status: "POSTED", source_event_id: "fleet-cash-payment:1:44",
        date: "2026-11-17", ref: "QA44", description: "Pembayaran driver fleet - DEV QA",
        total_debit: "100000.00", total_credit: "100000.00", journal_id: 99,
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    expect((await request("/cash-payments", "POST", payment)).status).toBe(409);
    expect(database.query.mock.calls.some((call) => /INSERT INTO public.accounting_entries/.test(call[0]))).toBe(false);
  });
});
