import { prepareFutureCashSource, type FutureCashSource } from "./future-cash-source-identity";
import type { ServerOwnedCashDocument } from "./future-cash-private-receipt";

/**
 * SELECT-only reader for a future, server-owned document registry.
 * This does not authenticate the caller or certify a review. Only a future
 * signed Owner/Super Admin server endpoint may provide FutureCashSource.
 *
 * The migration is DEV-gated and NOT run automatically. Missing registry
 * access and unverified/revoked documents always return null.
 */
type RegistryRow = {
  transaction_id: string;
  company_id: number;
  account_id: number;
  cash_coa_id: number;
  object_bucket: string;
  object_path: string;
  document_sha256: string;
  source_fingerprint: string;
  direction: string;
  transaction_date: string;
  amount_cents: string;
  event_type: string | null;
  event_at: string | null;
  actor_email: string | null;
};
export interface FutureCashRegistrySqlReader {
  query(sql: string, parameters: readonly unknown[]): Promise<{ rows: RegistryRow[] }>;
}

export async function readVerifiedFutureCashDocument(
  source: FutureCashSource,
  db: FutureCashRegistrySqlReader,
): Promise<ServerOwnedCashDocument | null> {
  try {
    const { sourceFingerprint } = prepareFutureCashSource(source);
    const [whole, fraction = ""] = source.amount.split(".");
    const cents = (BigInt(whole!) * 100n +
      BigInt(fraction.padEnd(2, "0") || "0")).toString();

    const sql = [
      "SELECT d.transaction_id::text AS transaction_id,",
      "       d.company_id, d.account_id, d.cash_coa_id,",
      "       d.object_bucket, d.object_path,",
      "       d.document_sha256, d.source_fingerprint, d.direction,",
      "       d.transaction_date::text AS transaction_date,",
      "       d.amount_cents::text AS amount_cents,",
      "       ev.event_type, ev.event_at::text AS event_at,",
      "       ev.actor_email",
      "  FROM public.sc_future_cash_documents d",
      "  LEFT JOIN LATERAL (",
      "    SELECT event_type, event_at, actor_email",
      "      FROM public.sc_future_cash_document_events",
      "     WHERE transaction_id=d.transaction_id",
      "     ORDER BY event_id DESC LIMIT 1",
      "  ) ev ON TRUE",
      " WHERE d.transaction_id=$1::uuid",
      "   AND d.company_id=$2 AND d.account_id=$3 LIMIT 2",
    ].join("\n");
    const result = await db.query(sql, [source.transactionId, 1, 18]);
    if (result.rows.length !== 1) return null;
    const row = result.rows[0]!;
    if (row.company_id !== 1 || row.account_id !== 18 ||
        row.cash_coa_id !== 75839 ||
        row.transaction_id !== source.transactionId ||
        row.document_sha256 !== source.sourceDocumentSha256 ||
        row.source_fingerprint !== sourceFingerprint ||
        row.object_bucket !== "private-uploads" ||
        row.direction !== source.direction ||
        row.transaction_date !== source.date ||
        row.amount_cents !== cents ||
        row.event_type !== "VERIFIED" ||
        !row.actor_email || !row.event_at) return null;
    const verified = new Date(row.event_at);
    if (!Number.isFinite(verified.getTime())) return null;
    // The byte-level PR246 check separately confirms object contents.
    return {
      transactionId: source.transactionId,
      companyId: 1,
      accountId: 18,
      objectPath: row.object_path,
      verifiedSha256: row.document_sha256,
      status: "VERIFIED",
      verifiedBy: row.actor_email,
      verifiedAt: verified.toISOString(),
    };
  } catch {
    return null; // Never leak SQL errors, object paths or actor identities.
  }
}
