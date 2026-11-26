import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prepareFutureCashSource, type FutureCashSource } from "../lib/future-cash-source-identity";
import { inspectPrivateFutureCashReadiness, type PrivateFutureCashEvidenceRepository }
  from "../lib/future-cash-private-evidence-readiness";
import type { PrivateCashFileReader, ServerOwnedCashDocument }
  from "../lib/future-cash-private-receipt";

const id = "33333333-3333-4333-8333-333333333333";
const path = "/objects/uploads/44444444-4444-4444-8444-444444444444.pdf";
const bytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const hash = createHash("sha256").update(bytes).digest("hex");
const source: FutureCashSource = {
  companyId: 1, accountId: 18, cashCoaId: 75839, transactionId: id,
  sourceDocumentSha256: hash, direction: "OUT", amount: "50000.00", date: "2026-11-27",
};
const doc: ServerOwnedCashDocument = {
  transactionId: id, companyId: 1, accountId: 18, objectPath: path,
  verifiedSha256: hash, status: "VERIFIED", verifiedBy: "owner@example.test",
  verifiedAt: "2026-11-27T00:01:00Z",
};
const approval = {
  transactionId: id, companyId: 1, accountId: 18,
  sourceFingerprint: prepareFutureCashSource(source).sourceFingerprint,
  counterCoaId: 902, status: "APPROVED" as const,
  authenticationMethod: "SIGNED_EMAIL_OTP" as const,
  authorizedRole: "owner" as const, approvedAt: "2026-11-27T00:02:00Z",
};
function backend(): PrivateFutureCashEvidenceRepository {
  return {
    getDocumentForTransaction: vi.fn(async () => doc),
    getSignedApprovalForTransaction: vi.fn(async () => approval),
    getCompanyCoa: vi.fn(async () =>
      ({ id: 902, companyId: 1, isActive: true, isPostable: true, isHeader: false })),
  };
}
function storage(content = bytes): PrivateCashFileReader {
  return {
    getObjectEntitySize: vi.fn(async () => content.byteLength),
    getObjectEntityFile: vi.fn(async () =>
      ({ bucket: "private-uploads", path: path.slice("/objects/".length) })),
    downloadObject: vi.fn(async () => ({
      arrayBuffer: async () => Uint8Array.from(content).buffer as ArrayBuffer,
    })),
  };
}
describe("Account18 private source bytes + trusted approval composition", () => {
  it("accepts only read-only draft with matching stored bytes, approval and COA", async () => {
    expect(await inspectPrivateFutureCashReadiness(source, backend(), storage()))
      .toEqual({ eligibleForReadOnlyDraft: true, readyForCommit: false,
        reason: "ELIGIBLE_FOR_READ_ONLY_DRAFT" });
  });
  it("halts before approval lookup if private bytes changed", async () => {
    const reader = backend();
    const result = await inspectPrivateFutureCashReadiness(
      source, reader, storage(Buffer.from("%PDF-1.7\nMODIFIED")));
    expect(result).toEqual({ eligibleForReadOnlyDraft: false, readyForCommit: false,
      reason: "RECEIPT_NOT_VERIFIED" });
    expect(reader.getSignedApprovalForTransaction).not.toHaveBeenCalled();
    expect(reader.getCompanyCoa).not.toHaveBeenCalled();
  });
  it("blocks revoked and wrong-company documents", async () => {
    for (const changed of [{ ...doc, status: "REVOKED" as const }, { ...doc, companyId: 3 }]) {
      const reader = { ...backend(), getDocumentForTransaction: vi.fn(async () => changed) };
      expect((await inspectPrivateFutureCashReadiness(source, reader, storage()))
        .eligibleForReadOnlyDraft).toBe(false);
      expect(reader.getSignedApprovalForTransaction).not.toHaveBeenCalled();
    }
  });
  it("rejects stale or unbound signed approvals after document verification", async () => {
    for (const changed of [
      { ...approval, approvedAt: "2026-11-26T23:00:00Z" },
      { ...approval, sourceFingerprint: "f".repeat(64) },
      { ...approval, companyId: 3 },
    ]) {
      const reader = { ...backend(), getSignedApprovalForTransaction: vi.fn(async () => changed) };
      expect(await inspectPrivateFutureCashReadiness(source, reader, storage()))
        .toMatchObject({ eligibleForReadOnlyDraft: false, readyForCommit: false,
          reason: "APPROVAL_NOT_VERIFIED" });
    }
  });
  it("rejects changed amount, invalid counter COA and repository errors", async () => {
    expect((await inspectPrivateFutureCashReadiness({ ...source, amount: "50000.01" },
      backend(), storage())).eligibleForReadOnlyDraft).toBe(false);
    const badCoa = { ...backend(), getCompanyCoa: vi.fn(async () =>
      ({ id: 902, companyId: 1, isActive: false, isPostable: true, isHeader: false })) };
    expect((await inspectPrivateFutureCashReadiness(source, badCoa, storage()))
      .reason).toBe("COA_NOT_ELIGIBLE");
    const unavailable = { ...backend(), getDocumentForTransaction: vi.fn(async () => {
      throw Error("sensitive-secret");
    }) };
    expect(JSON.stringify(await inspectPrivateFutureCashReadiness(source, unavailable, storage())))
      .toBe('{"eligibleForReadOnlyDraft":false,"readyForCommit":false,"reason":"EVIDENCE_REPOSITORY_UNAVAILABLE"}');
  });
  it("rejects unsupported Account18 scope before repository calls", async () => {
    const reader = backend();
    expect((await inspectPrivateFutureCashReadiness({ ...source, accountId: 1 },
      reader, storage())).eligibleForReadOnlyDraft).toBe(false);
    expect(reader.getDocumentForTransaction).not.toHaveBeenCalled();
  });
});
