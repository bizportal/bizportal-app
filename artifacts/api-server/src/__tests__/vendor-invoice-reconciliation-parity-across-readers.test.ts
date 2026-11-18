import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guard the previously-PASS canonical Vendor Invoice amount-paid semantics
// against drift in the new Bank Disbursement outstanding review adapter.
const purchase = readFileSync(resolve(process.cwd(), "src/routes/purchase-workflow.ts"), "utf8");
const accounting = readFileSync(resolve(process.cwd(), "src/routes/accounting.ts"), "utf8");

function reconciledAllocationSource(source: string): string {
  const start = source.indexOf("with reconciled_vendor_invoice_payments as (");
  expect(start).toBeGreaterThan(-1);
  const endToken = "group by 1, 2";
  const end = source.indexOf(endToken, start);
  expect(end).toBeGreaterThan(start);
  // Whitespace and SQL formatting may differ without changing the expression.
  return source.slice(start, end + endToken.length).replace(/\s+/g, "").toLowerCase();
}

describe("Vendor Invoice canonical payment balance shared by AP and BD readers", () => {
  it("uses the same reconciled allocation expression for both readers", () => {
    expect(reconciledAllocationSource(accounting)).toBe(reconciledAllocationSource(purchase));
  });

  it("requires active, company-scoped, finalized allocations on both paths", () => {
    for (const expression of [reconciledAllocationSource(accounting), reconciledAllocationSource(purchase)]) {
      expect(expression).toContain("public.payment_allocationspa");
      expect(expression).toContain("pa)->>'company_id'");
      expect(expression).toContain("bm.company_id=");
      expect(expression).toContain("is_active");
      expect(expression).toContain("final");
      expect(expression).toContain("reconciled");
    }
  });

  it("never allows review-only outstanding data to become payment authority", () => {
    const start = accounting.indexOf('router.get("/accounting/bank-disbursements/vendor-invoices/outstanding"');
    expect(start).toBeGreaterThan(-1);
    const end = accounting.indexOf("\n});", start);
    const route = accounting.slice(start, end);
    expect(route).toContain("reviewOnly: true");
    expect(route).toContain("canPay: false");
    expect(route).not.toContain("vi.amount_paid");
    expect(route).not.toContain("postEntry(");
    expect(route).not.toContain("router.post(");
  });
});
