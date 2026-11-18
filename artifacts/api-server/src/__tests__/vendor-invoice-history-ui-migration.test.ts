import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "../bizportal/src/pages/purchase/vendor-invoices.tsx"), "utf8");

describe("Vendor AP historical evidence — UI fail-closed migration contract", () => {
  it("shows informational warnings for reversal, orphan and VOIDED bank disbursements", () => {
    expect(source).toContain("Jurnal invoice ini sudah dibalik");
    expect(source).toContain("Bank Disbursement historis sudah dibatalkan");
    expect(source).toContain("Periksa Bank Disbursement historis sebelum membayar lagi");
    expect(source).toContain("Catatan ini bukan bukti pembayaran final");
  });

  it("does not offer the invoice-specific payment shortcut when historical evidence is unresolved", () => {
    // Only the evidence-reviewed invoice detail may link directly to disbursement.
    // The list-level shortcut must not bypass reversal/orphan checks.
    expect(source).toContain('<Eye className="h-3 w-3" />Periksa sebelum bayar');
    const detailShortcut = source.lastIndexOf('invoiceIds=${vi.id}');
    expect(detailShortcut).toBeGreaterThan(-1);
    expect(source.slice(0, detailShortcut)).not.toContain('<Banknote className="h-3 w-3" />Bayar');
    const nearby = source.slice(Math.max(0, detailShortcut - 420), detailShortcut + 450);
    expect(nearby).toContain('vi.status === "posted"');
    expect(nearby).toContain("outstandingPayment > 0.01");
    expect(nearby).toContain("!vi.journalReversalEntryId");
    expect(nearby).toContain("!(vi.orphanDisbursementNumbers?.length)");
    expect(nearby).toContain("!(vi.linkedVoidedDisbursementNumbers?.length)");
  });

  it("exposes evidence as optional metadata rather than treating it as an amount paid", () => {
    expect(source).toContain("orphanDisbursementNumbers?: string[]");
    expect(source).toContain("linkedVoidedDisbursementNumbers?: string[]");
    expect(source).toContain("journalReversalEntryId?: number | null");
    expect(source).toContain("reconciledAmountPaid?: string | number | null");
  });
});
