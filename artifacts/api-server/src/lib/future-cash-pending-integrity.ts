import { createHash } from "node:crypto";
import { prepareFutureCashSource, type FutureCashSource } from "./future-cash-source-identity";
import type { PrivateCashFileReader } from "./future-cash-private-receipt";

type PendingRow = {
  transaction_id: string; company_id: number; account_id: number;
  cash_coa_id: number; object_bucket: string; object_path: string;
  document_sha256: string; source_fingerprint: string;
  direction: string; transaction_date: string; amount_cents: string;
  byte_length: number | string; event_count: string | number;
};

export interface PendingCashIntegritySqlReader {
  query(sql: string, params: readonly unknown[]): Promise<{ rows: PendingRow[] }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRIVATE_PATH = /^\/objects\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:pdf|png|jpe?g|webp)$/;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Owner-authenticated server-side audit for PENDING evidence, with no writer.
 * MATCH certifies stored bytes + source fingerprint, NOT business meaning,
 * reviewer approval, VERIFIED status, or posting permission.
 * Do not expose the object path, hash, uploader, or binary to the HTTP client.
 */
export async function auditPendingFutureCashBytes(
  transactionId: string,
  db: PendingCashIntegritySqlReader,
  storage: PrivateCashFileReader,
): Promise<"MATCH" | "UNAVAILABLE"> {
  if (!UUID.test(transactionId)) return "UNAVAILABLE";
  try {
    const result = await db.query([
      "select d.transaction_id::text, d.company_id, d.account_id, d.cash_coa_id,",
      "d.object_bucket, d.object_path, d.document_sha256, d.source_fingerprint,",
      "d.direction, d.transaction_date::text as transaction_date,",
      "d.amount_cents::text as amount_cents, d.byte_length,",
      "(select count(*) from public.sc_future_cash_document_events e",
      " where e.transaction_id=d.transaction_id)::text as event_count",
      "from public.sc_future_cash_documents d",
      "where d.transaction_id=$1::uuid and d.company_id=1 and d.account_id=18 limit 2",
    ].join("\n"), [transactionId]);
    if (result.rows.length !== 1) return "UNAVAILABLE";
    const d = result.rows[0]!;
    const expectedLength = Number(d.byte_length);
    if (d.transaction_id !== transactionId || d.company_id !== 1 ||
        d.account_id !== 18 || d.cash_coa_id !== 75839 ||
        d.object_bucket !== "private-uploads" ||
        !PRIVATE_PATH.test(d.object_path) ||
        !/^[0-9a-f]{64}$/.test(d.document_sha256) ||
        d.event_count.toString() !== "0" ||
        !Number.isSafeInteger(expectedLength) ||
        expectedLength <= 0 || expectedLength > MAX_BYTES ||
        !/^[0-9]+$/.test(d.amount_cents)) return "UNAVAILABLE";
    const cents = BigInt(d.amount_cents);
    if (cents <= 0n) return "UNAVAILABLE";
    const amount = (cents / 100n).toString() + "." + (cents % 100n).toString().padStart(2, "0");
    const source: FutureCashSource = {
      transactionId, companyId: 1, accountId: 18, cashCoaId: 75839,
      sourceDocumentSha256: d.document_sha256,
      direction: d.direction as "IN" | "OUT", date: d.transaction_date, amount,
    };
    if (prepareFutureCashSource(source).sourceFingerprint !== d.source_fingerprint)
      return "UNAVAILABLE";

    const handle = await storage.getObjectEntityFile(d.object_path);
    const reportedSize = await storage.getObjectEntitySize(d.object_path);
    if (handle.bucket !== "private-uploads" ||
        handle.path !== d.object_path.slice("/objects/".length) ||
        reportedSize !== expectedLength) return "UNAVAILABLE";
    const bytes = new Uint8Array(await (await storage.downloadObject(handle, 0)).arrayBuffer());
    if (bytes.byteLength !== expectedLength) return "UNAVAILABLE";
    if (d.object_path.endsWith(".pdf") &&
        Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-")
      return "UNAVAILABLE";
    if (d.object_path.endsWith(".png") &&
        !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10])))
      return "UNAVAILABLE";
    if (/\.jpe?g$/.test(d.object_path) &&
        !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255))
      return "UNAVAILABLE";
    if (d.object_path.endsWith(".webp") &&
        !(Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
          Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"))
      return "UNAVAILABLE";
    return createHash("sha256").update(bytes).digest("hex") === d.document_sha256
      ? "MATCH" : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}
