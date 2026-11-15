import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInvoicePdfBuffer } from "./pdfInvoice.js";

describe("canonical Purchase PDF official CST logo regression", () => {
  it("renders an actual A4 PDF with the bundled PNG, not browser PDFKit fs shims", async () => {
    const officialLogo = readFileSync(resolve(process.cwd(), "../bizportal/public/cst-logo.png"));
    const pdf = await buildInvoicePdfBuffer({
      title: "PURCHASE ORDER",
      docNumber: "PO-DEV-LOGO-TEST",
      kind: "order",
      status: "confirmed",
      companyName: "PT Cahaya Sejati Teknologi",
      companyAddress: "GEDUNG SPORT CENTER, Bandara Soekarno-Hatta, Tangerang",
      partyLabel: "Vendor",
      partyName: "Supplier Synthetic Test",
      createdAt: "2026-11-15T01:00:00.000Z",
      lines: [{
        name: "Jasa kirim",
        description: "Pengiriman synthetic",
        quantity: 2,
        unitPrice: 150000,
        subtotal: 300000,
      }],
      totalAmount: 300000,
      taxAmount: 0,
      grandTotal: 300000,
      staticCompanyLogo: officialLogo,
      template: {
        companyName: "PT Cahaya Sejati Teknologi",
        companyAddress: "GEDUNG SPORT CENTER, Tangerang",
        primaryColor: "#1e3a6e",
        footerText: "Synthetic DEV preview only",
      },
    });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(60000);
    expect(pdf.toString("latin1")).toContain("/Subtype /Image");
    expect(pdf.toString("latin1").trimEnd()).toMatch(/%%EOF$/);
  });
});
