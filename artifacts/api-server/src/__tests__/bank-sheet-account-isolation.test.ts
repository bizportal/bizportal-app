import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertBankMutationWriterAccountType, previewCashSheetRows } from "../lib/bank-sheet-sync";

const routeSource = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
);
const syncSource = readFileSync(
  resolve(process.cwd(), "src/lib/bank-sheet-sync.ts"),
  "utf8",
);
const isolationSql = readFileSync(
  resolve(process.cwd(), "scripts/ensure-bank-sheet-account-isolation.sql"),
  "utf8",
);

describe("Google Sheet reconciliation account isolation", () => {
  it("allows the same spreadsheet to be reused only through a different tab", () => {
    expect(isolationSql).toContain(
      "bank_sheet_configs_company_sheet_tab_unique",
    );
    expect(isolationSql).toContain(
      "on public.bank_sheet_configs(company_id, sheet_id, tab_name)",
    );
  });

  it("binds each active sheet config to a company-owned reconciliation account", () => {
    expect(isolationSql).toContain("bank_sheet_configs_company_account_fkey");
    expect(isolationSql).toContain(
      "foreign key (company_id, bank_account_id)",
    );
    expect(isolationSql).toContain(
      "bank_sheet_configs_active_requires_scope_ck",
    );
    expect(isolationSql).toContain(
      "bank_sheet_configs_one_active_per_account",
    );
    expect(routeSource).toContain(
      "Tambahkan Akun Rekonsiliasi baru untuk mengaktifkan tab lain.",
    );
    expect(syncSource).toContain(
      "Tab mutasidev adalah sumber DEV dan tidak boleh dibaca dari production.",
    );
    expect(routeSource).toContain(
      "Perusahaan, Akun Rekonsiliasi, Label, dan Sheet ID wajib diisi",
    );
  });

  it("persists the configured bank account on every Google Sheet mutation", () => {
    expect(syncSource).toContain(
      "canonicalKey(row, config.company_id, config.bank_account_id)",
    );
    expect(syncSource).toContain("bm.bank_account_id = $5");
    expect(syncSource).toContain("config.bank_account_id");
    expect(isolationSql).toContain(
      "trg_enforce_google_sheet_mutation_scope",
    );
    expect(isolationSql).toContain(
      "Google Sheet mutation scope mismatch",
    );
  });

  it("supports filtering and matching by reconciliation account", () => {
    expect(routeSource).toContain("req.query.bank_account_id");
    expect(routeSource).toContain("bm.bank_account_id::text");
    expect(routeSource).toContain("bank_account_id?: unknown");
    expect(routeSource).toContain("bm.bank_account_id =");
  });
});

describe("Cash ledger must never use the bank mutation writer", () => {
  it("rejects a cash account before the bank writer can touch Sheets or DB", () => {
    expect(() => assertBankMutationWriterAccountType("cash"))
      .toThrow("CASH_SHEET_REQUIRES_CASH_LEDGER_IMPORT_PATH");
    expect(() => assertBankMutationWriterAccountType(" CASH "))
      .toThrow("CASH_SHEET_REQUIRES_CASH_LEDGER_IMPORT_PATH");
  });
  it("preserves existing noncash bank behavior", () => {
    expect(() => assertBankMutationWriterAccountType("bank")).not.toThrow();
  });
  it("checks the source before opening DB connections and Sheets API", () => {
    const syncStart = syncSource.indexOf("async function syncConfig(config: SheetConfig)");
    const guard = syncSource.indexOf("assertBankMutationWriterAccountType(config.account_type)", syncStart);
    const connection = syncSource.indexOf("const client = await pool.connect()", syncStart);
    const sheets = syncSource.indexOf("readSpreadsheetValues(config.sheet_id, config.tab_name)", syncStart);
    expect(syncStart).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(syncStart);
    expect(connection).toBeGreaterThan(guard);
    expect(sheets).toBeGreaterThan(guard);
  });
});

describe("CST-DEV Kas Besar SC read-only preflight", () => {
  const headers = ["Tanggal", "Keterangan COA", "Debit", "Kredit", "Saldo", "Pemasukan/Pengeluaran"];
  it("recognizes one cash inflow and one cash outflow without any writes", () => {
    expect(previewCashSheetRows([
      headers,
      ["25/11/2026", "Contoh penerimaan", "100000", "", "100000", "Pemasukan"],
      ["26/11/2026", "Contoh pengeluaran", "", "25000", "75000", "Pengeluaran"],
    ])).toMatchObject({
      headerValid: true, nonemptyRows: 2, importableRows: 2,
      rejectedRows: 0, ambiguousBothSides: 0,
      incomingRows: 1, outgoingRows: 1, safeToImport: true,
    });
  });
  it("blocks rows with invalid dates or both debit and credit values", () => {
    expect(previewCashSheetRows([
      headers,
      ["not-a-date", "invalid", "1000", "", "", ""],
      ["26/11/2026", "ambiguous", "100", "50", "", ""],
    ])).toMatchObject({
      importableRows: 1, rejectedRows: 1, rejectedRowNumbers: [2], ambiguousBothSides: 1, safeToImport: false,
    });
  });
  it("identifies a cash opening balance without inventing a transaction or passing the gate", () => {
    expect(previewCashSheetRows([
      ["Tanggal", "Keterangan COA", "Debit", "Kredit", "Saldo"],
      ["06/22/2026", "opening balance example", "SALDO AWAL", "", "13793"],
      ["26/11/2026", "cash payment", "", "25000", "0"],
    ])).toMatchObject({
      headerValid: true, nonemptyRows: 2, importableRows: 1,
      rejectedRows: 0, rejectedRowNumbers: [],
      openingBalanceRows: 1, openingBalanceRowNumbers: [2],
      incomingRows: 0, outgoingRows: 1, safeToImport: false,
    });
  });
  it("reports opening amount and repeated canonical transactions without changing import policy", () => {
    expect(previewCashSheetRows([
      headers,
      ["opening", "SALDO AWAL kas", "", "", "15000", ""],
      ["26/11/2026", "same payment", "", "2000", "13000", "Pengeluaran"],
      ["26/11/2026", "same payment", "", "2000", "11000", "Pengeluaran"],
      ["26/11/2026", "other payment", "", "2000", "9000", "Pengeluaran"],
    ])).toMatchObject({
      headerValid: true, nonemptyRows: 4, importableRows: 3,
      rejectedRows: 0, openingBalanceRows: 1, openingBalanceRowNumbers: [2],
      openingBalanceAmount: 15000,
      potentialDuplicateTransactions: 1, potentialDuplicateRowNumbers: [4],
      incomingRows: 0, outgoingRows: 3, safeToImport: false,
    });
  });
  it("keeps exact repeated transactions blocked, even without an opening row", () => {
    expect(previewCashSheetRows([
      headers,
      ["26/11/2026", "same receipt", "1000", "", "1000", "Pemasukan"],
      ["26/11/2026", "same receipt", "1000", "", "2000", "Pemasukan"],
    ])).toMatchObject({
      openingBalanceRows: 0, openingBalanceAmount: null,
      importableRows: 2, potentialDuplicateTransactions: 1,
      potentialDuplicateRowNumbers: [3], safeToImport: false,
    });
  });
  it("does not flag transactions with distinct canonical date or narrative", () => {
    expect(previewCashSheetRows([
      headers,
      ["25/11/2026", "receipt", "1000", "", "1000", "Pemasukan"],
      ["26/11/2026", "receipt", "1000", "", "2000", "Pemasukan"],
      ["26/11/2026", "other receipt", "1000", "", "3000", "Pemasukan"],
    ])).toMatchObject({
      potentialDuplicateTransactions: 0, potentialDuplicateRowNumbers: [],
      openingBalanceAmount: null, safeToImport: true,
    });
  });
  it("does not misclassify a malformed SALDO AWAL without a usable balance", () => {
    expect(previewCashSheetRows([
      ["Tanggal", "Keterangan COA", "Debit", "Kredit", "Saldo"],
      ["06/22/2026", "unusable opening balance", "SALDO AWAL", "", ""],
    ])).toMatchObject({
      importableRows: 0, rejectedRows: 1, rejectedRowNumbers: [2],
      openingBalanceRows: 0, safeToImport: false,
    });
  });
  it("diagnoses malformed cash opening row with booleans only", () => {
    expect(previewCashSheetRows([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "Saldo"],
      ["06/22/2026", "sample", "NOT A NUMBER", "", ""],
    ])).toMatchObject({
      firstRejectedRowShape: {
        rowNumber: 2, dateValid: true, debitNumeric: false,
        creditNumeric: false, debitHasSaldoAwal: false,
        anyCellHasSaldoAwal: false,
        saldoHeaderPresent: true, saldoNumeric: false,
      },
      safeToImport: false,
    });
  });
  it("classifies first-row opening marker in description without a valid date, but keeps import locked", () => {
    expect(previewCashSheetRows([
      ["Tanggal", "Keterangan COA", "Debit", "Kredit", "Saldo"],
      ["opening", "SALDO AWAL kas", "", "", "15000"],
      ["26/11/2026", "cash receipt", "2000", "", "17000"],
    ])).toMatchObject({
      headerValid: true, nonemptyRows: 2, importableRows: 1,
      rejectedRows: 0, rejectedRowNumbers: [], openingBalanceRows: 1,
      openingBalanceRowNumbers: [2], safeToImport: false,
    });
  });
  it("does not classify a mid-ledger SALDO AWAL marker as a safe opening baseline", () => {
    expect(previewCashSheetRows([
      ["Tanggal", "Keterangan COA", "Debit", "Kredit", "Saldo"],
      ["26/11/2026", "cash receipt", "2000", "", "2000"],
      ["opening", "SALDO AWAL in wrong row", "", "", "15000"],
    ])).toMatchObject({
      importableRows: 1, rejectedRows: 1,
      rejectedRowNumbers: [3], openingBalanceRows: 0, safeToImport: false,
    });
  });
  it("never passes unrecognized headers", () => {
    expect(previewCashSheetRows([["unknown", "other"], ["anything", "else"]]))
      .toMatchObject({ headerValid: false, safeToImport: false });
  });
  it("keeps the endpoint read-only and locked to CST-DEV cash config #5", () => {
    expect(routeSource).toContain('router.get("/bank-reconciliation/sheet-configs/5/preview"');
    expect(routeSource).toContain('const rows = await readSpreadsheetValues(config.sheet_id, config.tab_name)');
    expect(routeSource).toContain('if (!actor?.signedSuperAdmin || companyId !== 1');
    expect(routeSource).toContain('config.bank_account_id !== 18');
    expect(routeSource).toContain('mode: "read_only_no_sync"');
    expect(routeSource).toContain("from public.company_bank_accounts where id=$1 and company_id=$2");
    expect(routeSource).toContain("[18, 1]");
    expect(routeSource).toContain('databaseDuplicateCheck: "NOT_RUN_READER_HAS_NO_MUTATIONS_SELECT"');
    expect(routeSource).toContain("safeToImport: false, mode:");
  });
});
