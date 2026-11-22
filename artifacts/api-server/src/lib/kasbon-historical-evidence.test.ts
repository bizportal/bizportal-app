import { describe, expect, it } from "vitest";
import { classifyKasbonEvidence, parseKasbonAmount, type KasbonEvidence } from "./kasbon-historical-evidence";

const verified = (): KasbonEvidence => ({
  status: "partial",
  lifecycle_status: "partially_settled",
  posting_status: "posted",
  approved_at: "2026-10-01T00:00:00Z",
  approved_by: "owner-1",
  disbursed_at: "2026-10-02T00:00:00Z",
  disbursed_by: "finance-1",
  accounting_entry_id: "123",
  voided_at: null,
  remaining_amount: "11000000.00",
});

describe("historical Kasbon evidence is never fabricated", () => {
  it("classifies a fully evidenced posted outstanding advance", () => {
    expect(classifyKasbonEvidence(verified())).toEqual({
      verifiedDisbursement: true, requiresSourceReview: false, remainingAmount: "11000000.00",
    });
  });
  it.each(["draft", "void", "repaid", "rejected", "cancelled"])(
    "rejects excluded status %s", (status) => {
      expect(classifyKasbonEvidence({ ...verified(), status }).verifiedDisbursement).toBe(false);
    },
  );
  it.each([
    { approved_at: null }, { approved_by: "" }, { disbursed_at: null },
    { disbursed_by: " " }, { accounting_entry_id: null }, { posting_status: "pending" },
    { voided_at: "2026-11-01" }, { lifecycle_status: "unknown" },
  ])("rejects missing or invalid confirmation evidence %#", (patch) => {
    expect(classifyKasbonEvidence({ ...verified(), ...patch }))
      .toMatchObject({ verifiedDisbursement: false, requiresSourceReview: true });
  });
  it("does not mark a fully settled zero balance as outstanding", () => {
    expect(classifyKasbonEvidence({ ...verified(), remaining_amount: "0.00" }))
      .toEqual({ verifiedDisbursement: false, requiresSourceReview: false, remainingAmount: "0.00" });
  });
  it.each([null, "", "-1", "NaN", "1e4", "123.456", "001.00", 1.12, Infinity])(
    "rejects unsafe amount %s rather than silently calculating a balance", (value) => {
      expect(() => parseKasbonAmount(value)).toThrow("KASBON_INVALID_AMOUNT");
    },
  );
});
