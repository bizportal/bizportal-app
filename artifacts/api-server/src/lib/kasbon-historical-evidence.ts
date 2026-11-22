/**
 * Pure Kasbon source-evidence classifier, extracted from the historical
 * read-only Advance route. No SQL, network calls, API routes, or writes.
 * Unverified entries must never be presented as confirmed financial debt.
 */
export type KasbonEvidence = {
  status: unknown;
  lifecycle_status: unknown;
  posting_status: unknown;
  approved_at: unknown;
  approved_by: unknown;
  disbursed_at: unknown;
  disbursed_by: unknown;
  accounting_entry_id: unknown;
  voided_at: unknown;
  remaining_amount: unknown;
};

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Database numeric values arrive as decimal strings. Never coerce malformed
 * amounts to 0, or treat a draft balance as verified.
 */
export function parseKasbonAmount(value: unknown): string {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  if (!/^(0|[1-9][0-9]{0,15})(?:\.[0-9]{1,2})?$/.test(raw)) {
    throw new Error("KASBON_INVALID_AMOUNT");
  }
  return raw;
}

export function classifyKasbonEvidence(row: KasbonEvidence): {
  verifiedDisbursement: boolean;
  requiresSourceReview: boolean;
  remainingAmount: string;
} {
  if (!row || typeof row !== "object") throw new Error("KASBON_INVALID_ROW");
  const remainingAmount = parseKasbonAmount(row.remaining_amount);
  const outstanding = Number(remainingAmount) > 0;
  const status = normalized(row.status);
  const lifecycle = normalized(row.lifecycle_status);
  const verifiedDisbursement = outstanding &&
    !["draft", "void", "repaid", "rejected", "cancelled"].includes(status) &&
    ["outstanding", "partially_settled", "disbursed"].includes(lifecycle) &&
    row.approved_at != null && nonempty(row.approved_by) &&
    row.disbursed_at != null && nonempty(row.disbursed_by) &&
    row.accounting_entry_id != null &&
    normalized(row.posting_status) === "posted" &&
    row.voided_at == null;
  return {
    verifiedDisbursement,
    requiresSourceReview: outstanding && !verifiedDisbursement,
    remainingAmount,
  };
}
