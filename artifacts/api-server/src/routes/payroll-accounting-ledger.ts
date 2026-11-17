import { moneyToCents } from "./payroll-kasbon-automatic";

export type PayrollJournalLine = {
  account_id: number; debit: string; credit: string; description: string | null;
};
export type PayrollLedgerRow = PayrollJournalLine & {
  company_id: number; ledger_date: string; period: string;
  source_type: string; source_id: number | null; source_ref: string | null;
  currency: string; is_voided: boolean; void_ref_id: string | null;
};
export type PayrollLedgerJournal = {
  companyId: number; runId: number; entryNumber: string; date: string;
};
function fail(): never { throw Error("PAYROLL_ATOMIC_LEDGER_SYNC_NOT_VERIFIED"); }
function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}
function fingerprint(row: PayrollJournalLine): string {
  if (!positiveId(row.account_id) || (row.description !== null && typeof row.description !== "string")) fail();
  let debit: bigint, credit: bigint;
  try { debit = moneyToCents(row.debit); credit = moneyToCents(row.credit); }
  catch { return fail(); }
  if ((debit === 0n && credit === 0n) || (debit > 0n && credit > 0n)) fail();
  return JSON.stringify([row.account_id, debit.toString(), credit.toString(), row.description]);
}

/** Read-only comparison, never a second ledger writer or repair routine.
 * Called on freshly database-loaded, company-scoped rows inside the same
 * transaction as the journal and kasbon. The original trigger catches INSERT
 * failures as warnings, so a posted header alone does not prove ledger sync.
 * Compare the exact multiset (including repeated account lines), not only totals.
 * This function authenticates neither a browser nor a database connection.
 */
export function assertPayrollLedgerMirror(
  journal: PayrollLedgerJournal,
  lines: readonly PayrollJournalLine[],
  ledger: readonly PayrollLedgerRow[],
): void {
  if (!positiveId(journal.companyId) || !positiveId(journal.runId) ||
      typeof journal.entryNumber !== "string" || !journal.entryNumber.trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(journal.date) || !lines.length || lines.length !== ledger.length)
    fail();
  const date = Date.parse(journal.date + "T00:00:00Z");
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== journal.date) fail();
  for (const row of ledger) {
    if (row.company_id !== journal.companyId || row.source_type !== "payroll" ||
        row.source_id !== journal.runId || row.source_ref !== journal.entryNumber ||
        row.ledger_date !== journal.date || row.period !== journal.date.slice(0, 7) ||
        row.currency !== "IDR" || row.is_voided !== false || row.void_ref_id !== null) fail();
  }
  const expected = lines.map(fingerprint).sort();
  const observed = ledger.map(fingerprint).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) fail();
}
