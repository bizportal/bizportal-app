import { createHash, randomUUID } from "node:crypto";

/**
 * Pending-only upload contract for NEW CST / Sport Center Account18 vouchers.
 *
 * The caller must already have a server-verified company1 Owner/Super Admin
 * session and independently issued transaction UUID. This helper never
 * authenticates a caller, verifies a document or approves a financial posting.
 *
 * The writer is provided by ObjectStorageService, not by browser JSON.
 */
export type FutureCashPrivateUploadScope = Readonly<{
  companyId: number;
  accountId: number;
  transactionId: string;
}>;

export type PrivateCashUploadOptions = Readonly<{
  contentType: "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
  upsert: false;
}>;

export type PendingPrivateCashEvidence = Readonly<{
  companyId: 1;
  accountId: 18;
  transactionId: string;
  objectPath: string;
  sha256: string;
  byteLength: number;
  status: "PENDING_VERIFICATION";
}>;

export type PrivateCashNoOverwriteWriter = (
  relativePath: string,
  bytes: Buffer,
  options: PrivateCashUploadOptions,
) => Promise<void>;

const CASH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 8 * 1024 * 1024;

function detectCashFile(bytes: Buffer): Readonly<{
  extension: "pdf" | "png" | "jpg" | "webp";
  contentType: PrivateCashUploadOptions["contentType"];
}> | null {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { extension: "pdf", contentType: "application/pdf" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  )) {
    return { extension: "png", contentType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 255 &&
      bytes[1] === 216 && bytes[2] === 255) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}

/**
 * Writes one server-generated random private path, with upsert:false.
 * The file hash is calculated over exactly the bytes submitted to Storage.
 *
 * IMPORTANT: A successful upload is merely PENDING. A separate persistent
 * server-owned verification record, revocation policy and signed email-OTP
 * approval are required before this may be used by the read-only preflight.
 * Do not use the existing generic upsert:true uploader as this writer.
 */
export async function stageFutureCashPrivateEvidence(
  scope: FutureCashPrivateUploadScope,
  bytes: Buffer,
  writeNoOverwrite: PrivateCashNoOverwriteWriter,
): Promise<PendingPrivateCashEvidence> {
  if (scope.companyId !== 1 || scope.accountId !== 18 ||
      !CASH_UUID.test(scope.transactionId)) {
    throw new Error("CASH_EVIDENCE_SCOPE_INVALID");
  }
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 5 ||
      bytes.byteLength > MAX_BYTES) {
    throw new Error("CASH_EVIDENCE_SIZE_INVALID");
  }
  const copy = Buffer.from(bytes);
  const fileType = detectCashFile(copy);
  if (!fileType) throw new Error("CASH_EVIDENCE_TYPE_INVALID");

  const relativePath = "uploads/" + randomUUID() + "." + fileType.extension;
  const digest = createHash("sha256").update(copy).digest("hex");
  await writeNoOverwrite(relativePath, copy, {
    contentType: fileType.contentType,
    upsert: false,
  });

  return {
    companyId: 1,
    accountId: 18,
    transactionId: scope.transactionId,
    objectPath: "/objects/" + relativePath,
    sha256: digest,
    byteLength: copy.byteLength,
    status: "PENDING_VERIFICATION",
  };
}
