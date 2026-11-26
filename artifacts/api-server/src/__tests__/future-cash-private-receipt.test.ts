import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prepareFutureCashSource, type FutureCashSource } from "../lib/future-cash-source-identity";
import { assessFutureCashDraft } from "../lib/future-cash-approval-preflight";
import { verifyPrivateFutureCashReceipt, type PrivateCashFileReader,
  type ServerOwnedCashDocument } from "../lib/future-cash-private-receipt";

const transactionId = "33333333-3333-4333-8333-333333333333";
const objectId = "44444444-4444-4444-8444-444444444444";
const objectPath = "/objects/uploads/" + objectId + ".pdf";
const bytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const source: FutureCashSource = {
  transactionId, companyId: 1, accountId: 18, cashCoaId: 75839,
  sourceDocumentSha256: sha256, date: "2026-11-27",
  direction: "OUT", amount: "50000.00",
};
const record: ServerOwnedCashDocument = {
  transactionId, companyId: 1, accountId: 18, objectPath,
  verifiedSha256: sha256, status: "VERIFIED",
  verifiedBy: "owner@example.test", verifiedAt: "2026-11-27T00:01:00Z",
};
function fileReader(content = bytes) {
  return {
    getObjectEntitySize: vi.fn(async () => content.byteLength),
    getObjectEntityFile: vi.fn(async () => ({
      bucket: "private-uploads", path: objectPath.slice("/objects/".length),
    })),
    downloadObject: vi.fn(async () => ({
      arrayBuffer: async () => Uint8Array.from(content).buffer as ArrayBuffer,
    })),
  } satisfies PrivateCashFileReader;
}

describe("Account18 cash private receipt hash check — no business writes", () => {
  it("hashes actual private bytes, then only permits a read-only evidence draft", async () => {
    const storage = fileReader();
    const verified = await verifyPrivateFutureCashReceipt(source, record, storage);
    expect(verified).toEqual({
      transactionId, companyId: 1, accountId: 18, sha256,
      status: "VERIFIED", verifiedAt: record.verifiedAt,
    });
    expect(storage.getObjectEntitySize).toHaveBeenCalledWith(objectPath);
    expect(storage.getObjectEntityFile).toHaveBeenCalledWith(objectPath);
    const approval = {
      transactionId, companyId: 1, accountId: 18,
      sourceFingerprint: prepareFutureCashSource(source).sourceFingerprint,
      counterCoaId: 902, status: "APPROVED" as const,
      authenticationMethod: "SIGNED_EMAIL_OTP" as const,
      authorizedRole: "owner" as const, approvedAt: "2026-11-27T00:02:00Z",
    };
    expect(assessFutureCashDraft(source, verified, approval,
      { id:902, companyId:1, isActive:true, isPostable:true, isHeader:false }))
      .toMatchObject({ eligibleForReadOnlyDraft:true, readyForCommit:false });
  });

  it("rejects missing, revoked and wrong-company records before any storage access", async () => {
    for (const rec of [null, { ...record, status: "REVOKED" as const },
      { ...record, status: "PENDING" as const }, { ...record, companyId: 3 },
      { ...record, transactionId: "55555555-5555-4555-8555-555555555555" },
      { ...record, verifiedAt: "2026-11-27" }]) {
      const storage = fileReader();
      expect(await verifyPrivateFutureCashReceipt(source, rec, storage)).toBeNull();
      expect(storage.downloadObject).not.toHaveBeenCalled();
    }
  });

  it("rejects public storage, traversals, wrong digest and modified bytes", async () => {
    const publicStorage = fileReader();
    publicStorage.getObjectEntityFile.mockResolvedValue({
      bucket: "payment-proofs", path: objectPath.slice("/objects/".length),
    });
    expect(await verifyPrivateFutureCashReceipt(source, record, publicStorage)).toBeNull();
    expect(publicStorage.downloadObject).not.toHaveBeenCalled();
    for (const malformed of ["/objects/../uploads/"+objectId+".pdf",
      "https://example.test/receipt.pdf", "/objects/uploads/"+objectId+".exe"]) {
      const storage = fileReader();
      expect(await verifyPrivateFutureCashReceipt(source,
        { ...record, objectPath: malformed }, storage)).toBeNull();
      expect(storage.downloadObject).not.toHaveBeenCalled();
    }
    expect(await verifyPrivateFutureCashReceipt(source, record,
      fileReader(Buffer.from("%PDF-1.7\nCHANGED\n")))).toBeNull();
    expect(await verifyPrivateFutureCashReceipt(source, {
      ...record, verifiedSha256: "0".repeat(64),
    }, fileReader())).toBeNull();
  });

  it("fails closed for fake extensions, mismatched magic and oversized metadata", async () => {
    const invalidMagic = fileReader(Buffer.from("not actually a PDF"));
    expect(await verifyPrivateFutureCashReceipt(source, record, invalidMagic)).toBeNull();
    const tooLarge = fileReader();
    tooLarge.getObjectEntitySize.mockResolvedValue(9*1024*1024);
    expect(await verifyPrivateFutureCashReceipt(source, record, tooLarge)).toBeNull();
    expect(tooLarge.downloadObject).not.toHaveBeenCalled();
    const wrongLength = fileReader();
    wrongLength.getObjectEntitySize.mockResolvedValue(bytes.length+1);
    expect(await verifyPrivateFutureCashReceipt(source, record, wrongLength)).toBeNull();
  });

  it("fails closed without exposing storage exception details", async () => {
    const storage = fileReader();
    storage.getObjectEntitySize.mockRejectedValue(Error("private-storage-credential"));
    const result = await verifyPrivateFutureCashReceipt(source, record, storage);
    expect(result).toBeNull();
  });
});
