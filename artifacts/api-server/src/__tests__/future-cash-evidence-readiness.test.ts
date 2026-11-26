import { describe, expect, it, vi } from "vitest";
import { prepareFutureCashSource, type FutureCashSource } from "../lib/future-cash-source-identity";
import { inspectFutureCashEvidence, type FutureCashEvidenceReader } from "../lib/future-cash-evidence-readiness";

const source: FutureCashSource = {
  companyId: 1, accountId: 18, cashCoaId: 75839,
  transactionId: "33333333-3333-4333-8333-333333333333",
  sourceDocumentSha256: "a".repeat(64), direction: "OUT",
  date: "2026-11-27", amount: "50000.00",
};
const receipt = {
  transactionId: source.transactionId, companyId: 1, accountId: 18,
  sha256: source.sourceDocumentSha256, status: "VERIFIED" as const,
  verifiedAt: "2026-11-27T00:00:00Z",
};
const approval = {
  transactionId: source.transactionId, companyId: 1, accountId: 18,
  sourceFingerprint: prepareFutureCashSource(source).sourceFingerprint,
  counterCoaId: 902, status: "APPROVED" as const,
  authenticationMethod: "SIGNED_EMAIL_OTP" as const,
  authorizedRole: "owner" as const, approvedAt: "2026-11-27T00:01:00Z",
};
function repository() {
  return {
    getVerifiedReceipt: vi.fn(async () => receipt),
    getSignedApproval: vi.fn(async () => approval),
    getCounterCoa: vi.fn(async () =>
      ({ id: 902, companyId: 1, isActive: true, isPostable: true, isHeader: false })),
  } satisfies FutureCashEvidenceReader;
}

describe("Account18 future cash server evidence readiness (no posting)", () => {
  it("loads trusted facts in order, never exposes evidence or enables commit", async () => {
    const reader = repository();
    expect(await inspectFutureCashEvidence(source, reader)).toEqual({
      eligibleForReadOnlyDraft: true, readyForCommit: false,
      reason: "ELIGIBLE_FOR_READ_ONLY_DRAFT",
    });
    expect(reader.getVerifiedReceipt).toHaveBeenCalledWith(source.transactionId);
    expect(reader.getSignedApproval).toHaveBeenCalledWith(source.transactionId);
    expect(reader.getCounterCoa).toHaveBeenCalledWith(1, 902);
  });

  it("rejects missing or revoked receipts without loading approvals", async () => {
    for (const status of ["PENDING", "REVOKED"] as const) {
      const reader = repository();
      reader.getVerifiedReceipt = vi.fn(async () => ({ ...receipt, status }));
      expect(await inspectFutureCashEvidence(source, reader)).toMatchObject({
        eligibleForReadOnlyDraft: false, readyForCommit: false,
        reason: "RECEIPT_NOT_VERIFIED",
      });
      expect(reader.getSignedApproval).not.toHaveBeenCalled();
    }
  });

  it("rejects changed amount, stale signature, wrong company and old approval", async () => {
    const badSource = { ...source, amount: "50000.01" };
    expect(await inspectFutureCashEvidence(badSource, repository())).toMatchObject({
      eligibleForReadOnlyDraft: false, readyForCommit: false,
      reason: "APPROVAL_NOT_VERIFIED",
    });
    const stale = repository();
    stale.getSignedApproval = vi.fn(async () => ({
      ...approval, approvedAt: "2026-11-26T23:59:59Z",
    }));
    expect(await inspectFutureCashEvidence(source, stale)).toMatchObject({
      eligibleForReadOnlyDraft: false, readyForCommit: false,
      reason: "APPROVAL_NOT_VERIFIED",
    });
    const foreign = repository();
    foreign.getSignedApproval = vi.fn(async () => ({ ...approval, companyId: 3 }));
    expect((await inspectFutureCashEvidence(source, foreign)).eligibleForReadOnlyDraft).toBe(false);
  });

  it("fails closed if repository cannot authenticate data, without leaking errors", async () => {
    const reader = repository();
    reader.getVerifiedReceipt = vi.fn(async () => { throw Error("db-password-secret"); });
    expect(JSON.stringify(await inspectFutureCashEvidence(source, reader)))
      .toBe('{"eligibleForReadOnlyDraft":false,"readyForCommit":false,"reason":"EVIDENCE_REPOSITORY_UNAVAILABLE"}');
  });

  it("rejects invalid voucher scope before calling repository", async () => {
    const reader = repository();
    expect(await inspectFutureCashEvidence({ ...source, accountId: 1 }, reader)).toMatchObject({
      eligibleForReadOnlyDraft: false, readyForCommit: false,
      reason: "EVIDENCE_REPOSITORY_UNAVAILABLE",
    });
    expect(reader.getVerifiedReceipt).not.toHaveBeenCalled();
  });
});
