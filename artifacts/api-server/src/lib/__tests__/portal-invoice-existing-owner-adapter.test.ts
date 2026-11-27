import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  drizzle: vi.fn(),
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: mocks.drizzle,
}));
vi.mock("../posting-engine/index.js", () => ({
  getPostingEngine: () => ({ post: mocks.post }),
}));
import { postCustomerInvoiceWithOriginalOwner } from "../posting-engine/portalInvoiceAdapter.js";

type Row = Record<string, unknown>;
const flag1 = "CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV";
const flag2 = "CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV";
const envValues = [process.env.APP_ENV, process.env[flag1], process.env[flag2]];
const invoice = (companyId = 1): Row => ({
  id: 17, company_id: companyId, status: "confirmed",
  invoice_status: "invoiced", invoice_number: "INV-DEV-17",
  invoice_date: "2026-11-18", due_date: "2026-12-18",
  grand_total: "100.00", total_amount: "100.00", amount_paid: "0.00",
  payment_status: "unpaid", tax_amount: "0.00", tax_rate_id: null, tax_treatment: null,
});
const settings = (companyId = 1): Row => ({
  ar_account_id: 101, sales_income_account_id: 401, sales_journal_id: 41,
  journal_code: "SAL", journal_company: companyId,
  journal_type: "sales", journal_active: true,
  ar_company: companyId, ar_type: "asset", ar_subtype: "receivable",
  ar_active: true, ar_postable: true, ar_header: false, ar_status: "ACTIVE",
  revenue_company: companyId, revenue_type: "revenue",
  revenue_active: true, revenue_postable: true, revenue_header: false, revenue_status: "ACTIVE",
});
function harness(companyId: 1 | 3 = 1) {
  const state = {
    source: invoice(companyId), config: settings(companyId),
    trace: { backend_pid: 177, xid: "4210", read_only: "off" } as Row,
    clientTrace: { backend_pid: 177, xid: "4210", read_only: "off" } as Row,
    line: { line_count: 1, line_total: "100.00" } as Row,
    statements: [] as string[],
  };
  const resolve = async (sql: string, _values?: unknown[], fromClient = false): Promise<{ rows: Row[] }> => {
    state.statements.push(sql);
    if (sql.includes("pg_backend_pid()")) return { rows: [fromClient ? state.clientTrace : state.trace] };
    if (sql.includes("from public.sales_documents")) return { rows: [state.source] };
    if (sql.includes("from public.sales_document_lines")) return { rows: [state.line] };
    if (sql.includes("from public.accounting_settings")) return { rows: [state.config] };
    if (sql.includes("insert into public.ledger_events") || sql.includes("insert into public.financial_outbox_events")) return { rows: [] };
    throw new Error("TEST_UNKNOWN_SQL:" + sql);
  };
  const query = vi.fn((sql: string, values?: unknown[]) => resolve(sql, values));
  const client = { query: vi.fn((sql: string, values?: unknown[]) => resolve(sql, values, true)) } as unknown as PoolClient;
  const request = {
    query, transactionClient: client, companyId, source: "sales_invoice" as const, sourceId: 17,
    invoice: { id: 17, company_id: companyId, invoice_number: "INV-DEV-17", grand_total: "100.00" },
    actorId: "super-admin-dev",
  };
  return { state, query, client, request };
}

beforeEach(() => {
  process.env.APP_ENV = "development";
  process.env[flag1] = "true";
  process.env[flag2] = "true";
  mocks.post.mockReset().mockResolvedValue({ ok: true, entryId: 555 });
  mocks.drizzle.mockReset().mockReturnValue({ marker: "bound-client" });
});
afterEach(() => {
  for (const [key, original] of [["APP_ENV", envValues[0]], [flag1, envValues[1]], [flag2, envValues[2]]] as const) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});
describe("Customer Portal DEV → real canonical owner same-transaction adapter", () => {
  for (const companyId of [1, 3] as const) {
    it("passes real source identity and company " + companyId + " mapping to EXISTING engine, then writes bound audit/outbox", async () => {
      const h = harness(companyId);
      const receipt = await postCustomerInvoiceWithOriginalOwner(h.request);
      expect(receipt).toEqual({ posted: true, entryId: 555 });
      expect(mocks.drizzle).toHaveBeenCalledWith(h.client);
      expect(mocks.post).toHaveBeenCalledTimes(1);
      const [posting, bound] = mocks.post.mock.calls[0];
      expect(bound).toEqual({ marker: "bound-client" });
      expect(posting).toMatchObject({
        companyId, source: "sales_invoice", sourceId: 17,
        journalId: 41, journalCode: "SAL", ref: "INV-DEV-17",
        lines: [
          { accountId: 101, debit: 100, credit: 0 },
          { accountId: 401, debit: 0, credit: 100 },
        ],
      });
      expect(h.state.statements.filter(x => x.includes("insert into public.ledger_events"))).toHaveLength(1);
      expect(h.state.statements.filter(x => x.includes("insert into public.financial_outbox_events"))).toHaveLength(1);
    });
  }
  it("refuses flag OFF and every production env without touching a transaction", async () => {
    const h = harness();
    process.env[flag1] = "false";
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("DEV_FLAGS_OFF");
    process.env[flag1] = "true";
    process.env.APP_ENV = "production";
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("DEV_FLAGS_OFF");
    expect(h.query).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("denies mismatched caller company and arbitrary source before any SQL", async () => {
    const h = harness();
    await expect(postCustomerInvoiceWithOriginalOwner({ ...h.request, companyId: 3 }))
      .rejects.toThrow("COMPANY_OR_SOURCE_MISMATCH");
    expect(h.query).not.toHaveBeenCalled();
  });
  it("rejects separate connections or missing assigned write transaction", async () => {
    const h = harness();
    h.state.clientTrace = { ...h.state.clientTrace, backend_pid: 999 };
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("NOT_SAME_WRITABLE_TRANSACTION");
    h.state.clientTrace = { ...h.state.trace, xid: null };
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("NOT_SAME_WRITABLE_TRANSACTION");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("rejects source company mismatch and stale invoice amount", async () => {
    const h = harness();
    h.state.source = { ...h.state.source, company_id: 3 };
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("INVALID_INVOICE_SOURCE");
    h.state.source = invoice();
    h.state.source.grand_total = "101.00";
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("INVALID_INVOICE_SOURCE");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("fails closed on taxable invoices or unaccounted adjustments", async () => {
    const h = harness();
    h.state.source.tax_amount = "11.00";
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("TAX_OR_ADJUSTMENT_UNSUPPORTED");
    h.state.source = { ...invoice(), tax_rate_id: 5 };
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("TAX_OR_ADJUSTMENT_UNSUPPORTED");
    h.state.source = { ...invoice(), total_amount: "99.00" };
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("TAX_OR_ADJUSTMENT_UNSUPPORTED");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("rejects missing document lines, foreign/missing company settings, or invalid revenue type", async () => {
    const h = harness();
    h.state.line = { line_count: 0, line_total: "0.00" };
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("LINE_TOTAL_MISMATCH");
    h.state.line = { line_count: 1, line_total: "100.00" };
    h.state.config = { ...settings(), revenue_company: 3 };
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("INVALID_COMPANY_ACCOUNTING_MAPPING");
    h.state.config = { ...settings(), revenue_type: "expense" };
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("INVALID_COMPANY_ACCOUNTING_MAPPING");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("does not emit audit/outbox if canonical owner rejects", async () => {
    const h = harness();
    mocks.post.mockResolvedValue({ ok: false, errorCode: "PERIOD_CLOSED" });
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("EXISTING_ENGINE_REJECTED");
    expect(h.state.statements.some(x => x.includes("insert into public.ledger_events"))).toBe(false);
    expect(h.state.statements.some(x => x.includes("insert into public.financial_outbox_events"))).toBe(false);
  });
  it("requires valid receipt and does not acknowledge an unposted journal", async () => {
    const h = harness();
    mocks.post.mockResolvedValue({ ok: true, entryId: null });
    await expect(postCustomerInvoiceWithOriginalOwner(h.request)).rejects.toThrow("EXISTING_ENGINE_REJECTED");
  });
});
