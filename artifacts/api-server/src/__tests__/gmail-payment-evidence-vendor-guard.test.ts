import { describe, expect, it } from "vitest";
import { classifyGmailVendorCandidate, isPaymentEvidenceSubject } from "../lib/gmail-invoice-candidates";

const complete = { hasDuplicate: false, hasCoreFields: true, confidence: 0.99 };

describe("Gmail payment evidence never becomes payable Vendor Invoice", () => {
  it.each([
    "Payment slip PT Cahaya Sejati Teknologi",
    "Fwd: Payment-slip PT Cahaya Sejati Teknologi",
    "Payment advice - transfer completed",
    "Remittance Advice September",
    "Bukti Transfer Bank",
    "Konfirmasi pembayaran invoice",
  ])("sends payment proof to Finance review: %s", (subject) => {
    expect(isPaymentEvidenceSubject(subject)).toBe(true);
    expect(classifyGmailVendorCandidate({ ...complete, subject })).toBe("manual_review");
  });

  it.each([
    "INVOICE Layanan Oktober 2026",
    "Fwd: Tagihan sewa gudang",
    "Faktur pembelian dari pemasok",
  ])("preserves normal vendor invoice classification: %s", (subject) => {
    expect(isPaymentEvidenceSubject(subject)).toBe(false);
    expect(classifyGmailVendorCandidate({ ...complete, subject })).toBe("ready");
  });

  it("keeps the existing duplicate and low-confidence safeguards", () => {
    expect(classifyGmailVendorCandidate({ ...complete, subject: "Invoice vendor", hasDuplicate: true })).toBe("duplicate");
    expect(classifyGmailVendorCandidate({ ...complete, subject: "Invoice vendor", confidence: 0.2 })).toBe("manual_review");
    expect(classifyGmailVendorCandidate({ ...complete, subject: "Invoice vendor", hasCoreFields: false })).toBe("manual_review");
  });
});
