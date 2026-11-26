import { createHash } from "node:crypto";

/** Internal cash-only posting contract. No route or DB writer is connected yet. */
export type CashScope = Readonly<{
  companyId: number;
  configId: number;
  accountId: number;
  accountType: "cash";
  cashCoaId: number;
  counterpartyCoaId: number;
}>;
export type CashMovement = Readonly<{
  rowNumber: number;
  date: string; // ISO calendar date
  direction: "IN" | "OUT";
  amount: string; // Decimal IDR amount, never floating point
  sourceFingerprint: string; // SHA256 from validated source-only dry-run
}>;
export type CashLine = Readonly<{ accountId: number; debitCents: bigint; creditCents: bigint }>;
export type CashJournal = Readonly<{
  sourceKey: string;
  fingerprint: string;
  date: string;
  amountCents: bigint;
  lines: readonly [CashLine, CashLine];
}>;
export type StoredCashJournal = Readonly<{ id: string; fingerprint: string }>;

function assertPositiveId(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`INVALID_${label}`);
}
function cents(amount: string): bigint {
  if (typeof amount !== "string" || !/^(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(amount)) {
    throw new Error("INVALID_CASH_AMOUNT");
  }
  const [whole, fraction = ""] = amount.split(".");
  const result = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (result <= 0n) throw new Error("INVALID_CASH_AMOUNT");
  return result;
}
export function prepareCashJournal(scope: CashScope, movement: CashMovement): CashJournal {
  if (scope.accountType !== "cash") throw new Error("CASH_ONLY_ACCOUNT_REQUIRED");
  for (const [n, label] of [[scope.companyId, "COMPANY"], [scope.configId, "CONFIG"],
    [scope.accountId, "ACCOUNT"], [scope.cashCoaId, "CASH_COA"],
    [scope.counterpartyCoaId, "COUNTERPARTY_COA"], [movement.rowNumber, "ROW"]] as const) {
    assertPositiveId(n, label);
  }
  if (scope.cashCoaId === scope.counterpartyCoaId) throw new Error("SAME_SIDE_COA_FORBIDDEN");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movement.date)
    || Number.isNaN(Date.parse(movement.date + "T00:00:00Z"))
    || new Date(movement.date + "T00:00:00Z").toISOString().slice(0,10) !== movement.date) {
    throw new Error("INVALID_CASH_DATE");
  }
  if (movement.direction !== "IN" && movement.direction !== "OUT") throw new Error("INVALID_CASH_DIRECTION");
  if (!/^[a-f0-9]{64}$/.test(movement.sourceFingerprint)) throw new Error("INVALID_SOURCE_FINGERPRINT");
  const amountCents = cents(movement.amount);
  const sourceKey = createHash("sha256").update(JSON.stringify([
    "cst-cash-sheet-row-v1", scope.companyId, scope.configId, scope.accountId, movement.rowNumber,
  ])).digest("hex");
  const cashLine: CashLine = { accountId: scope.cashCoaId,
    debitCents: movement.direction === "IN" ? amountCents : 0n,
    creditCents: movement.direction === "OUT" ? amountCents : 0n };
  const contraLine: CashLine = { accountId: scope.counterpartyCoaId,
    debitCents: movement.direction === "OUT" ? amountCents : 0n,
    creditCents: movement.direction === "IN" ? amountCents : 0n };
  if (cashLine.debitCents + contraLine.debitCents !== cashLine.creditCents + contraLine.creditCents) {
    throw new Error("UNBALANCED_CASH_JOURNAL");
  }
  return { sourceKey, fingerprint: movement.sourceFingerprint, date: movement.date,
    amountCents, lines: [cashLine, contraLine] };
}
/** Adapter transaction must lock source key and atomically create journal header + two lines.
 * No physical tables/credentials are defined here; only a disposable adapter is tested.
 * Caller must independently verify source exceptions, opening balance and Owner approval.
 */
export interface CashLedgerTx {
  findForUpdate(sourceKey: string): Promise<StoredCashJournal | null>;
  insertWithLines(journal: CashJournal): Promise<string>;
}
export interface CashLedgerAdapter {
  transaction<T>(callback: (tx: CashLedgerTx) => Promise<T>): Promise<T>;
}
export async function postCashJournal(
  adapter: CashLedgerAdapter,
  scope: CashScope,
  movement: CashMovement,
): Promise<{ id: string; replay: boolean }> {
  const plan = prepareCashJournal(scope, movement);
  return adapter.transaction(async tx => {
    const existing = await tx.findForUpdate(plan.sourceKey);
    if (existing) {
      if (existing.fingerprint !== plan.fingerprint) throw new Error("CASH_SOURCE_CHANGED_REVIEW_REQUIRED");
      return { id: existing.id, replay: true };
    }
    const id = await tx.insertWithLines(plan);
    if (!id) throw new Error("CASH_JOURNAL_INSERT_FAILED");
    return { id, replay: false };
  });
}
export function reverseCashJournalLines(lines: readonly [CashLine, CashLine]): readonly [CashLine, CashLine] {
  return lines.map(line => ({ accountId: line.accountId,
    debitCents: line.creditCents, creditCents: line.debitCents })) as unknown as readonly [CashLine, CashLine];
}
