import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ui = readFileSync(resolve(process.cwd(), "../bizportal/src/pages/accounting/bank-disbursements.tsx"), "utf8");
const route = readFileSync(resolve(process.cwd(), "src/routes/accounting.ts"), "utf8");

describe("DEV outstanding review cannot authorize a bank payment", () => {
  it("exposes an explicit review-only response with no canPay capability", () => {
    expect(route).toContain("coverage: \"vendor_invoice_only\"");
    expect(route).toContain("reviewOnly: true as const, canPay: false as const");
    expect(route).toContain("reviewOnly: true, canPay: false");
  });

  it("does not offer review-only invoice rows for payment selection", () => {
    expect(ui).toContain("allInvoices={outstandingData?.reviewOnly ? [] : (outstandingData?.invoices ?? [])}");
    expect(ui).toContain("Data outstanding hanya untuk pemeriksaan");
  });

  it("rejects review-only vendor payment in the event handler, not just button styling", () => {
    const start = ui.indexOf("const handleSubmit = async () => {");
    const end = ui.indexOf("setSaving(true);", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const guard = ui.slice(start, end);
    expect(guard).toContain('paymentMode === "vendor_invoice" && outstandingData?.reviewOnly');
    expect(guard).toContain("return;");
    expect(ui).toContain('disabled={saving || isUploadingAttachment || (paymentMode === "vendor_invoice" && outstandingData?.reviewOnly === true)}');
  });

  it("prevents quick invoice creation and posting in review-only mode", () => {
    const start = ui.indexOf("const handleQuickCreateVendorInvoice = async () => {");
    const end = ui.indexOf("const positiveLines =", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(ui.slice(start, end)).toContain("if (outstandingData?.reviewOnly)");
    expect(ui.slice(start, end)).toContain("return;");
    expect(ui).toContain("!outstandingData?.reviewOnly && ocrApplied && ocrResult");
  });

  it("does not add a bank writer route", () => {
    expect(route).not.toContain('router.post("/accounting/bank-disbursements"');
    expect(route).not.toContain('router.post("/accounting/bank-disbursements/:id/void"');
  });
});
