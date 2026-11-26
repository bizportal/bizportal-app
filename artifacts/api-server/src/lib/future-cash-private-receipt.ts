import { createHash } from "node:crypto";
import { prepareFutureCashSource, type FutureCashSource } from "./future-cash-source-identity";
import type { TrustedFutureCashReceipt } from "./future-cash-approval-preflight";

/**
 * Adapter for the EXISTING ObjectStorageService private-uploads methods.
 * The server must load ServerOwnedCashDocument from a company-scoped,
 * access-controlled, immutable record; never accept it from browser JSON.
 * This module does not issue verification, authorize OTP, or post journals.
 */
export interface PrivateCashFileReader {
  getObjectEntitySize(path: string): Promise<number>;
  getObjectEntityFile(path: string): Promise<{ bucket: string; path: string }>;
  downloadObject(file: { bucket: string; path: string }, cacheTtlSec?: number):
    Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

export type ServerOwnedCashDocument = Readonly<{
  transactionId: string;
  companyId: number;
  accountId: number;
  objectPath: string;
  verifiedSha256: string;
  status: "VERIFIED" | "PENDING" | "REVOKED";
  verifiedBy: string | null;
  verifiedAt: string | null;
}>;

const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const PRIVATE_PATH = /^\/objects\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:pdf|png|jpe?g|webp)$/;
const DIGEST = /^[a-f0-9]{64}$/;

function canonicalUtc(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return false;
  const normalized = instant.toISOString();
  return value === normalized || value === normalized.replace(/\.000Z$/, "Z") ||
    value === normalized.replace(/0+Z$/, "Z");
}

function hasExpectedMagic(path: string, bytes: Uint8Array): boolean {
  if (path.endsWith(".pdf")) return bytes.length >= 5 &&
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-";
  if (path.endsWith(".png")) return bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (path.endsWith(".jpg") || path.endsWith(".jpeg"))
    return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (path.endsWith(".webp")) return bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  return false;
}

/**
 * Actually downloads from the PRIVATE Supabase object path and hashes the
 * stored bytes. A matching file hash is NECESSARY, not sufficient: a trusted
 * reviewer/OTP audit must be independently authenticated by the caller.
 * Return null rather than leak private file or storage error details.
 */
export async function verifyPrivateFutureCashReceipt(
  source: FutureCashSource,
  record: ServerOwnedCashDocument | null,
  storage: PrivateCashFileReader,
): Promise<TrustedFutureCashReceipt | null> {
  try {
    prepareFutureCashSource(source);
    if (!record || record.status !== "VERIFIED" ||
        record.companyId !== 1 || record.accountId !== 18 ||
        record.companyId !== source.companyId || record.accountId !== source.accountId ||
        record.transactionId !== source.transactionId ||
        !DIGEST.test(record.verifiedSha256) ||
        record.verifiedSha256 !== source.sourceDocumentSha256 ||
        !PRIVATE_PATH.test(record.objectPath) ||
        !canonicalUtc(record.verifiedAt) ||
        !/^[a-zA-Z0-9@._-]{3,120}$/.test(record.verifiedBy ?? "")) return null;

    const expectedPath = record.objectPath.slice("/objects/".length);
    const reportedSize = await storage.getObjectEntitySize(record.objectPath);
    if (!Number.isSafeInteger(reportedSize) || reportedSize <= 0 ||
        reportedSize > MAX_RECEIPT_BYTES) return null;
    const file = await storage.getObjectEntityFile(record.objectPath);
    if (file.bucket !== "private-uploads" || file.path !== expectedPath) return null;
    const bytes = new Uint8Array(await (await storage.downloadObject(file, 0)).arrayBuffer());
    if (bytes.byteLength !== reportedSize || !hasExpectedMagic(record.objectPath, bytes)) return null;
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== record.verifiedSha256) return null;

    return {
      transactionId: source.transactionId,
      companyId: source.companyId,
      accountId: source.accountId,
      sha256: actualHash,
      status: "VERIFIED",
      verifiedAt: record.verifiedAt,
    };
  } catch {
    return null;
  }
}
