import crypto from "node:crypto";

/**
 * DEV cash-only planning boundary, NOT an accounting writer.
 * Source row identities are stable inside company/config/account scope.
 * Monetary values must arrive as integer cents; counter-account mapping
 * is mandatory and distinct from the verified cash COA.
 */
export type CashDraftRow = {
  rowNumber: number;
  transactionDate: string;
  direction: "IN" | "OUT";
  amountCents: number;
  sourceFingerprint: string;
  counterCoaId: number | null;
};

export type CashDraftScope = {
  companyId: number;
  configId: number;
  accountId: number;
  cashCoaId: number;
};

export type CashDraftLeg = {
  coaId: number;
  side: "DR" | "CR";
  amountCents: number;
};

export type CashDraftCandidate = {
  sourceKey: string;
  fingerprint: string;
  rowNumber: number;
  transactionDate: string;
  legs: [CashDraftLeg, CashDraftLeg];
};

type BlockedCashRow = {
  rowNumber: number;
  reason: "MISSING_COUNTER_COA" | "SELF_COUNTER_COA" | "INVALID_SOURCE";
};

const validId = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

function validateScope(scope: CashDraftScope): void {
  if (![scope.companyId, scope.configId, scope.accountId, scope.cashCoaId].every(validId)
      || scope.companyId !== 1 || scope.configId !== 5 || scope.accountId !== 18) {
    throw new Error("CASH_DRAFT_SCOPE_NOT_AUTHORIZED");
  }
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function planCashLedgerDrafts(
  scope: CashDraftScope,
  sourceRows: readonly CashDraftRow[],
  existingFingerprints: ReadonlyMap<string, string> = new Map(),
): {
  proposals: CashDraftCandidate[];
  blocked: BlockedCashRow[];
  newRows: number;
  replayedRows: number;
  changedRows: number;
  readyForCommit: false;
} {
  validateScope(scope);
  if (sourceRows.length > 1000) throw new Error("CASH_DRAFT_BATCH_TOO_LARGE");
  const proposals: CashDraftCandidate[] = [];
  const blocked: BlockedCashRow[] = [];
  const seen = new Set<number>();
  let newRows = 0;
  let replayedRows = 0;
  let changedRows = 0;

  for (const row of sourceRows) {
    if (!validId(row.rowNumber) || seen.has(row.rowNumber)) {
      blocked.push({ rowNumber: row.rowNumber, reason: "INVALID_SOURCE" });
      continue;
    }
    seen.add(row.rowNumber);
    if (!isValidDate(row.transactionDate)
        || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0
        || (row.direction !== "IN" && row.direction !== "OUT")
        || !/^[a-f0-9]{64}$/.test(row.sourceFingerprint)) {
      blocked.push({ rowNumber: row.rowNumber, reason: "INVALID_SOURCE" });
      continue;
    }
    if (!validId(row.counterCoaId ?? 0)) {
      blocked.push({ rowNumber: row.rowNumber, reason: "MISSING_COUNTER_COA" });
      continue;
    }
    if (row.counterCoaId === scope.cashCoaId) {
      blocked.push({ rowNumber: row.rowNumber, reason: "SELF_COUNTER_COA" });
      continue;
    }
    const sourceKey = crypto.createHash("sha256").update(JSON.stringify([
      "cst-cash-sheet-row-v1", scope.companyId, scope.configId,
      scope.accountId, row.rowNumber,
    ])).digest("hex");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
      "cst-cash-ledger-draft-v1", row.sourceFingerprint,
      row.transactionDate, row.direction, row.amountCents, row.counterCoaId,
    ])).digest("hex");
    const legs: [CashDraftLeg, CashDraftLeg] = row.direction === "IN"
      ? [
          { coaId: scope.cashCoaId, side: "DR", amountCents: row.amountCents },
          { coaId: row.counterCoaId!, side: "CR", amountCents: row.amountCents },
        ]
      : [
          { coaId: row.counterCoaId!, side: "DR", amountCents: row.amountCents },
          { coaId: scope.cashCoaId, side: "CR", amountCents: row.amountCents },
        ];

    // Fail closed on changed source data. Never silently replace approved drafts.
    const old = existingFingerprints.get(sourceKey);
    if (old === undefined) newRows++;
    else if (old === fingerprint) replayedRows++;
    else changedRows++;
    proposals.push({
      sourceKey, fingerprint, rowNumber: row.rowNumber,
      transactionDate: row.transactionDate, legs,
    });
  }
  return { proposals, blocked, newRows, replayedRows, changedRows, readyForCommit: false };
}
