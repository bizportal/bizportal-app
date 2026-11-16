import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Freeze existing canonical payment semantics while historical reversal/orphan
// evidence is assessed separately. This test does not touch a database.
const api = readFileSync(resolve(process.cwd(), "src/routes/purchase-workflow.ts"), "utf8");
const invoiceDetailStart = api.indexOf('router.get("/purchase-workflow/vendor-invoices/:id"');
const invoiceDetailEnd = api.indexOf('router.post("/purchase-workflow/vendor-invoices/:id/reset-payment"', invoiceDetailStart);
const detail = api.slice(invoiceDetailStart, invoiceDetailEnd);

describe("canonical vendor invoice payment provenance during repository migration", () => {
  it("keeps reconciled payment allocations as the amount-paid source", () => {
    expect(api).toContain("with reconciled_vendor_invoice_payments as (");
    expect(api).toContain("public.payment_allocations");
    expect(detail).toContain("coalesce(rvip.paid_amount, 0) reconciled_amount_paid");
    expect(detail).toContain("amountPaid: row.reconciled_amount_paid");
    expect(detail).not.toContain("amountPaid: row.amount_paid");
  });

  it("scopes the invoice detail lookup to company and invoice ID", () => {
    expect(invoiceDetailStart).toBeGreaterThan(-1);
    expect(invoiceDetailEnd).toBeGreaterThan(invoiceDetailStart);
    expect(detail).toContain("where vi.id = $2 and vi.company_id = $1");
    expect(detail).toContain("[companyId, invoiceId]");
  });

  it("does not silently infer a successful payment from journal status", () => {
    expect(detail).toContain("journalStatus: row.journal_status");
    expect(detail).toContain("reconciledAmountPaid: row.reconciled_amount_paid");
    expect(detail).not.toContain("amountPaid: row.journal_status");
  });
});
