import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildInvoicePdfBuffer } from "./pdfInvoice.js";

const require_ = createRequire(import.meta.url);
const parsePdf = require_("pdf-parse/lib/pdf-parse.js") as
  (bytes: Buffer) => Promise<{ text: string; numpages: number }>;

async function renderTaxedPurchase(taxRate?: number) {
  const pdf = await buildInvoicePdfBuffer({
    title: "PURCHASE ORDER",
    docNumber: "PO-SYNTHETIC-TAX",
    kind: "order", status: "confirmed",
    companyName: "PT Cahaya Sejati Teknologi",
    partyLabel: "Vendor", partyName: "Synthetic supplier",
    createdAt: "2026-11-15T01:00:00.000Z",
    lines: [{ name: "Jasa", quantity: 1, unitPrice: 100000, subtotal: 100000 }],
    totalAmount: 100000, taxAmount: 12000, grandTotal: 112000,
    taxRate,
    staticCompanyLogo: null,
  });
  return parsePdf(pdf);
}

describe("Purchase PDF tax label matches supplied transaction metadata", () => {
  it("does not invent PPN 11% when the canonical PO only supplies a tax total", async () => {
    const pdf = await renderTaxedPurchase();
    expect(pdf.numpages).toBe(1);
    expect(pdf.text).toContain("Pajak");
    expect(pdf.text).not.toContain("PPN 11%");
    expect(pdf.text).toContain("Rp 12.000");
  });
  it("prints an explicit validated tax rate when one is supplied", async () => {
    const pdf = await renderTaxedPurchase(12);
    expect(pdf.text).toContain("PPN 12%");
    expect(pdf.text).not.toContain("PPN 11%");
  });
});
