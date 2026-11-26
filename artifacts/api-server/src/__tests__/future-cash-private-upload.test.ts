import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { stageFutureCashPrivateEvidence, type PrivateCashNoOverwriteWriter }
  from "../lib/future-cash-private-upload";

const scope = {
  companyId: 1, accountId: 18,
  transactionId: "33333333-3333-4333-8333-333333333333",
};
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const writer = () => vi.fn<PrivateCashNoOverwriteWriter>(async () => {});

describe("Account18 pending private upload; NO POSTING", () => {
  it("issues only a server random path, hashes exact bytes and requires upsert:false", async () => {
    const upload = writer();
    const receipt = await stageFutureCashPrivateEvidence(scope, pdf, upload);
    expect(receipt).toMatchObject({
      companyId: 1, accountId: 18, transactionId: scope.transactionId,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      byteLength: pdf.length, status: "PENDING_VERIFICATION",
    });
    expect(receipt.objectPath).toMatch(
      /^\/objects\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.pdf$/,
    );
    expect(upload).toHaveBeenCalledTimes(1);
    const [path, file, options] = upload.mock.calls[0]!;
    expect("/objects/" + path).toBe(receipt.objectPath);
    expect(file).toEqual(pdf);
    expect(options).toEqual({ contentType: "application/pdf", upsert: false });
    expect(JSON.stringify(receipt)).not.toContain("VERIFIED\"");
    expect(JSON.stringify(receipt)).not.toContain("signed");
  });

  it("never reuses another upload's object path", async () => {
    const upload = writer();
    const first = await stageFutureCashPrivateEvidence(scope, pdf, upload);
    const second = await stageFutureCashPrivateEvidence(scope, pdf, upload);
    expect(first.objectPath).not.toBe(second.objectPath);
    for (const call of upload.mock.calls) expect(call[2].upsert).toBe(false);
  });

  it("blocks wrong company/account and invalid server transaction UUID before any upload", async () => {
    for (const invalid of [
      { ...scope, companyId: 3 },
      { ...scope, accountId: 1 },
      { ...scope, transactionId: "not-uuid" },
    ]) {
      const upload = writer();
      await expect(stageFutureCashPrivateEvidence(invalid, pdf, upload))
        .rejects.toThrow("CASH_EVIDENCE_SCOPE_INVALID");
      expect(upload).not.toHaveBeenCalled();
    }
  });

  it("rejects oversized, empty, unsupported and fake-extension input", async () => {
    const cases = [
      { file: Buffer.alloc(0), reason: "CASH_EVIDENCE_SIZE_INVALID" },
      { file: Buffer.alloc(8 * 1024 * 1024 + 1), reason: "CASH_EVIDENCE_SIZE_INVALID" },
      { file: Buffer.from("not really a PDF.pdf"), reason: "CASH_EVIDENCE_TYPE_INVALID" },
      { file: Buffer.from("GIF89a"), reason: "CASH_EVIDENCE_TYPE_INVALID" },
    ];
    for (const item of cases) {
      const upload = writer();
      await expect(stageFutureCashPrivateEvidence(scope, item.file, upload))
        .rejects.toThrow(item.reason);
      expect(upload).not.toHaveBeenCalled();
    }
  });

  it("detects PNG, JPEG and WebP by magic, not client-supplied MIME", async () => {
    for (const [file, suffix, type] of [
      [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ".png", "image/png"],
      [Buffer.from([255, 216, 255, 0, 0]), ".jpg", "image/jpeg"],
      [Buffer.from("RIFF0000WEBP"), ".webp", "image/webp"],
    ] as const) {
      const upload = writer();
      const result = await stageFutureCashPrivateEvidence(scope, file, upload);
      expect(result.objectPath.endsWith(suffix)).toBe(true);
      expect(upload.mock.calls[0]![2]).toEqual({ contentType: type, upsert: false });
    }
  });

  it("fails closed on storage duplicate, outage or denied upload without claiming success", async () => {
    for (const reason of ["Storage: object already exists", "Storage: permission denied"]) {
      const upload = vi.fn<PrivateCashNoOverwriteWriter>(async () => { throw Error(reason); });
      await expect(stageFutureCashPrivateEvidence(scope, pdf, upload))
        .rejects.toThrow(reason);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(upload.mock.calls[0]![2].upsert).toBe(false);
    }
  });
});
