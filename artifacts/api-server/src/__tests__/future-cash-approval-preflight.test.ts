import { describe, expect, it } from "vitest";
import { prepareFutureCashSource, type FutureCashSource } from "../lib/future-cash-source-identity";
import { assessFutureCashDraft, type TrustedFutureCashReceipt,
  type TrustedFutureCashApproval, type TrustedFutureCashCoa } from "../lib/future-cash-approval-preflight";

const source: FutureCashSource = {
  companyId: 1, accountId: 18, cashCoaId: 75839,
  transactionId: "33333333-3333-4333-8333-333333333333",
  sourceDocumentSha256: "a".repeat(64), date: "2026-11-27",
  direction: "IN", amount: "150000.25",
};
const receipt: TrustedFutureCashReceipt = {
  transactionId: source.transactionId, companyId: 1, accountId: 18,
  sha256: source.sourceDocumentSha256, status: "VERIFIED",
  verifiedAt: "2026-11-27T00:00:00Z",
};
const approval: TrustedFutureCashApproval = {
  transactionId: source.transactionId, companyId: 1, accountId: 18,
  sourceFingerprint: prepareFutureCashSource(source).sourceFingerprint,
  counterCoaId: 902, status: "APPROVED", authenticationMethod: "SIGNED_EMAIL_OTP",
  authorizedRole: "owner", approvedAt: "2026-11-27T00:01:00Z",
};
const coa: TrustedFutureCashCoa = {
  id: 902, companyId: 1, isActive: true, isPostable: true, isHeader: false,
};

describe("future Account18 cash draft approval preflight — pure QA only", () => {
  it("reports eligible read-only draft for matching trusted facts, NEVER commit", () => {
    expect(assessFutureCashDraft(source, receipt, approval, coa)).toMatchObject({
      eligibleForReadOnlyDraft: true, readyForCommit: false,
      counterCoaId: 902, reason: "ELIGIBLE_FOR_READ_ONLY_DRAFT",
    });
    expect(assessFutureCashDraft(source, receipt, { ...approval, authorizedRole: "super_admin" }, coa)
      .eligibleForReadOnlyDraft).toBe(true);
  });
  it("fails closed without a verified, timestamped, source-bound receipt", () => {
    for (const changed of [null, { ...receipt, status: "PENDING" as const },
      { ...receipt, status: "REVOKED" as const }, { ...receipt, accountId: 1 },
      { ...receipt, sha256: "b".repeat(64) }, { ...receipt, verifiedAt: "2026-11-27" }]) {
      expect(assessFutureCashDraft(source, changed, approval, coa).eligibleForReadOnlyDraft).toBe(false);
    }
  });
  it("fails closed on unsigned, wrong-scope, stale-source or missing approval", () => {
    for (const changed of [null, { ...approval, status: "PENDING" as const },
      { ...approval, authenticationMethod: "OTHER" as const },
      { ...approval, authorizedRole: "other" as const },
      { ...approval, companyId: 2 }, { ...approval, accountId: 1 },
      { ...approval, sourceFingerprint: "b".repeat(64) },
      { ...approval, counterCoaId: 903 }, { ...approval, approvedAt: "2026-11-27" }]) {
      const decision = assessFutureCashDraft(source, receipt, changed, coa);
      expect(decision.readyForCommit).toBe(false);
      if (changed && changed.counterCoaId === 903) {
        expect(decision.reason).toBe("COA_NOT_ELIGIBLE");
      } else {
        expect(decision.eligibleForReadOnlyDraft).toBe(false);
      }
    }
  });
  it("rejects approvals issued before the trusted receipt was verified", () => {
    for (const changed of [
      { ...approval, approvedAt: "2026-11-26T23:59:59Z" },
      { ...approval, approvedAt: "2026-11-26T00:00:00Z" },
    ]) {
      expect(assessFutureCashDraft(source, receipt, changed, coa)).toMatchObject({
        eligibleForReadOnlyDraft: false,
        readyForCommit: false,
        reason: "APPROVAL_NOT_VERIFIED",
      });
    }
    expect(assessFutureCashDraft(source, receipt, approval, coa)).toMatchObject({
      eligibleForReadOnlyDraft: true, readyForCommit: false,
    });
  });
  it("rejects wrong-company, self-counter, inactive or header COAs", () => {
    for (const changed of [null, { ...coa, companyId: 2 }, { ...coa, id: 75839 },
      { ...coa, isActive: false }, { ...coa, isPostable: false },
      { ...coa, isHeader: true }]) {
      expect(assessFutureCashDraft(source, receipt, approval, changed))
        .toMatchObject({ eligibleForReadOnlyDraft: false, readyForCommit: false });
    }
  });
  it("changed source data invalidates otherwise verified approval", () => {
    for (const changed of [{ ...source, amount: "150000.26" },
      { ...source, direction: "OUT" as const },
      { ...source, date: "2026-11-28" },
      { ...source, transactionId: "44444444-4444-4444-8444-444444444444" }]) {
      expect(assessFutureCashDraft(changed, receipt, approval, coa)
        .eligibleForReadOnlyDraft).toBe(false);
    }
  });
});
