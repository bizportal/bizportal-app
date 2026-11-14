import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPaymentEvidenceSubject } from "../lib/gmail-payment-evidence";

const uiSource = readFileSync(resolve(process.cwd(), "src/pages/finance/recon-config/InvoiceSourcesTab.tsx"), "utf8");

describe("Gmail candidate UI prevents payment evidence import", () => {
  it("identifies a saved payment slip independent of OCR status", () => {
    expect(isPaymentEvidenceSubject("Payment slip PT Cahaya Sejati Teknologi")).toBe(true);
    expect(isPaymentEvidenceSubject("Remittance Advice - bank receipt")).toBe(true);
    expect(isPaymentEvidenceSubject("Bukti transfer customer")).toBe(true);
    expect(isPaymentEvidenceSubject("Invoice pembelian barang")).toBe(false);
  });

  it("hides Buat Draft for historical ready payment-slip records while showing Finance review guidance", () => {
    expect(uiSource).toContain("const paymentEvidence = isPaymentEvidenceSubject(candidate.subject);");
    expect(uiSource).toContain("!paymentEvidence;");
    expect(uiSource).toContain("Bukti pembayaran — review Finance/AR, bukan tagihan vendor");
  });
});
