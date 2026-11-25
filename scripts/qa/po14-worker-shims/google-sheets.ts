/** Synthetic external transport; the imported bank-sheet service and SQL stay real. */
import { pool } from "./db";
export interface SpreadsheetValueUpdate { range: string; values: string[][] }
const sheetId = "QA-LOCAL-PO14";
const tabName = "mutasidev";
const fixtureRows = [
  ["Tanggal", "Keterangan", "Debit", "Kredit"],
  ["25/11/2026", "PT Cahaya Sejati Teknologi QA-PO14-INTERNAL-TEST-ONLY", "100.000", "0"],
];
export async function readSpreadsheetValues(id: string, tab: string): Promise<string[][]> {
  if (id !== sheetId || tab !== tabName) throw new Error("EXTERNAL_SHEET_FORBIDDEN_IN_PO14_WORKER");
  return fixtureRows.map(row => [...row]);
}
export async function writeSpreadsheetValues(id: string, updates: SpreadsheetValueUpdate[]): Promise<void> {
  if (id !== sheetId || updates.some(update => !update.range.startsWith("'mutasidev'!"))) {
    throw new Error("EXTERNAL_SHEET_FORBIDDEN_IN_PO14_WORKER");
  }
  await pool.query("insert into public.qa_worker_sheet_updates(payload) values($1::jsonb)", [JSON.stringify(updates)]);
}
export function spreadsheetCellRange(tab: string, columnNumber: number, rowNumber: number): string {
  let column = columnNumber + 1;
  let letters = "";
  while (column > 0) {
    letters = String.fromCharCode(65 + ((column - 1) % 26)) + letters;
    column = Math.floor((column - 1) / 26);
  }
  return `'${tab.replace(/'/g, "''")}'!${letters}${rowNumber}`;
}
export async function inspectSpreadsheet(): Promise<never> {
  throw new Error("EXTERNAL_SHEET_FORBIDDEN_IN_PO14_WORKER");
}
