import { createHash } from "node:crypto";

/**
 * Future cash source identity only. NO route, approval, database writer or
 * journal posting is authorized by this module.
 *
 * The caller must independently verify the source document, approval session,
 * company/account ownership and counter-COA before financial use.
 */
export type FutureCashSource = Readonly<{
  companyId: number;
  accountId: number;
  cashCoaId: number;
  transactionId: string;
  sourceDocumentSha256: string;
  direction: "IN" | "OUT";
  amount: string;
  date: string;
}>;

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function prepareFutureCashSource(source: FutureCashSource): Readonly<{
  sourceKey: string;
  sourceFingerprint: string;
}> {
  if (source.companyId !== 1 || source.accountId !== 18 || source.cashCoaId !== 75839) {
    throw new Error("UNSUPPORTED_FUTURE_CASH_SCOPE");
  }
  // An independently issued UUID, not a Sheet row number or Config #5 ID.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(source.transactionId)) {
    throw new Error("INVALID_FUTURE_CASH_TRANSACTION_ID");
  }
  if (!/^[a-f0-9]{64}$/.test(source.sourceDocumentSha256)) {
    throw new Error("INVALID_FUTURE_CASH_DOCUMENT_FINGERPRINT");
  }
  if (source.direction !== "IN" && source.direction !== "OUT") throw new Error("INVALID_FUTURE_CASH_DIRECTION");
  if (!validCalendarDate(source.date)) throw new Error("INVALID_FUTURE_CASH_DATE");
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(source.amount)) {
    throw new Error("INVALID_FUTURE_CASH_AMOUNT");
  }
  const [whole, fraction = ""] = source.amount.split(".");
  const amountCents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (amountCents <= 0n) throw new Error("INVALID_FUTURE_CASH_AMOUNT");

  const sourceKey = createHash("sha256").update(JSON.stringify([
    "cst-future-cash-transaction-v1", source.companyId, source.accountId, source.transactionId,
  ])).digest("hex");
  const sourceFingerprint = createHash("sha256").update(JSON.stringify([
    "cst-future-cash-evidence-v1", sourceKey, source.cashCoaId,
    source.sourceDocumentSha256, source.direction, amountCents.toString(), source.date,
  ])).digest("hex");
  return { sourceKey, sourceFingerprint };
}
