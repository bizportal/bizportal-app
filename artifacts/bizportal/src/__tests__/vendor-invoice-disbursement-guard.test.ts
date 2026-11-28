import { describe, expect, it } from "vitest";
import { canOfferVendorInvoicePayShortcut } from "@/lib/vendorInvoiceDisbursementGuard";

describe("Vendor Invoice Pay shortcut safety", () => {
  it("offers Pay for posted unpaid invoice with no prior posted disbursement", () => {
    expect(canOfferVendorInvoicePayShortcut("posted", 31_694_392, 0)).toBe(true);
  });

  it("hides Pay for VI/00006 while full posted BD awaits bank reconciliation", () => {
    expect(canOfferVendorInvoicePayShortcut("posted", 31_694_392, 31_694_392)).toBe(false);
  });

  it("hides Pay conservatively for an existing partial posted disbursement", () => {
    expect(canOfferVendorInvoicePayShortcut("posted", 20_000, 10_000)).toBe(false);
  });

  it("never offers Pay for draft, canceled, or already reconciled invoice", () => {
    expect(canOfferVendorInvoicePayShortcut("draft", 100_000, 0)).toBe(false);
    expect(canOfferVendorInvoicePayShortcut("cancelled", 100_000, 0)).toBe(false);
    expect(canOfferVendorInvoicePayShortcut("posted", 0, 0)).toBe(false);
  });

  it("fails closed on missing or invalid monetary data", () => {
    expect(canOfferVendorInvoicePayShortcut("posted", "NaN", 0)).toBe(false);
    expect(canOfferVendorInvoicePayShortcut("posted", 100_000, undefined)).toBe(false);
    expect(canOfferVendorInvoicePayShortcut("posted", 100_000, "not-a-number")).toBe(false);
  });
});
