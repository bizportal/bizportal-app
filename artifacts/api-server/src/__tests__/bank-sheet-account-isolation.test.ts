import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertBankMutationWriterAccountType, auditCashSheetRunningBalances, planCashSheetImportDryRun, previewCashSheetRows } from "../lib/bank-sheet-sync";

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

describe("Cash source-only dry-run replay and rollback", () => {
  const scope = { companyId: 1, configId: 5, accountId: 18 };
  const rows = [
    ["Tanggal", "Keterangan COA", "Debit", "Kredit", "Saldo"],
    ["metadata", "SALDO AWAL", "", "", "13793"],
    ["25/11/2026", "Cash receipt A", "2000", "", "15793"],
    ["26/11/2026", "Cash payment B", "", "1000", "14793"],
  ];

  it("proposes two cash rows, excluding opening balance, with no side effects", () => {
    const plan = planCashSheetImportDryRun(rows, scope);
    expect(plan).toMatchObject({
      totalParsedRows: 2, openingBalanceRows: 1, rejectedRows: 0,
      newRows: 2, replayedRows: 0, changedRows: 0,
      repeatedPayloadRows: 0, readyForCommit: false,
    });
    expect(plan.proposed).toHaveLength(2);
    for (const record of plan.proposed) {
      expect(record.sourceKey).toMatch(/^[a-f0-9]{64}$/);
      expect(record.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(record)).not.toContain("Cash");
    }
  });

  it("idempotent replay yields zero new candidates; rollback resets the ephemeral proposal", () => {
    const first = planCashSheetImportDryRun(rows, scope);
    const ephemeral = new Map(first.proposed.map((item) =>
      [item.sourceKey, item.fingerprint] as const));
    const replay = planCashSheetImportDryRun(rows, scope, ephemeral);
    expect(replay).toMatchObject({
      newRows: 0, replayedRows: 2, changedRows: 0,
      readyForCommit: false,
    });
    const rollback = planCashSheetImportDryRun(rows, scope);
    expect(rollback.newRows).toBe(2);
  });

  it("detects an edited source row without silently replacing previous content", () => {
    const first = planCashSheetImportDryRun(rows, scope);
    const ephemeral = new Map(first.proposed.map((item) =>
      [item.sourceKey, item.fingerprint] as const));
    const modified = rows.map((row) => [...row]);
    modified[2]![2] = "2500";
    const plan = planCashSheetImportDryRun(modified, scope, ephemeral);
    expect(plan).toMatchObject({
      newRows: 0, replayedRows: 1, changedRows: 1, readyForCommit: false,
    });
    expect(plan.proposed[0]?.sourceKey).toBe(first.proposed[0]?.sourceKey);
    expect(plan.proposed[0]?.fingerprint).not.toBe(first.proposed[0]?.fingerprint);
  });

  it("flags repeated payloads on distinct physical rows but keeps both candidates", () => {
    const repeated = [
      ["Tanggal", "Keterangan", "Debit", "Kredit"],
      ["25/11/2026", "same cash receipt", "1000", ""],
      ["25/11/2026", "same cash receipt", "1000", ""],
    ];
    expect(planCashSheetImportDryRun(repeated, scope)).toMatchObject({
      totalParsedRows: 2, newRows: 2, repeatedPayloadRows: 1,
      readyForCommit: false,
    });
  });

  it("reconciles opening balance and cash inflow/outflow without making ledger entries", () => {
    expect(auditCashSheetRunningBalances(rows)).toMatchObject({
      openingBalancePresent: true, checkedTransactions: 2,
      balanceMismatchRows: 0, balanceMismatchRowNumbers: [],
      missingBalanceRows: 0,
    });
  });

  it("reports bounded cash differences without modifying the source", () => {
    const rows = [
      ["Tanggal", "Keterangan COA", "Debit", "Kredit", "Saldo"],
      ["metadata", "SALDO AWAL", "", "", "13793"],
      ["25/11/2026", "receipt", "2000", "", "15700"],
      ["26/11/2026", "payment", "", "1000", "14700"],
    ];
    const result = auditCashSheetRunningBalances(rows);
    expect(result).toMatchObject({
      openingBalancePresent: true, openingBalanceAmount: 13793,
      checkedTransactions: 2, balanceMismatchRows: 1,
      balanceMismatchRowNumbers: [3],
      mismatchDetails: [{
        rowNumber: 3, expectedBalance: 15793,
        statedBalance: 15700, difference: -93,
      }],
    });
    expect(rows[2]?.[4]).toBe("15700");
  });
  it("locates running-balance mismatches and missing balances by source row", () => {
    const mismatch = rows.map((row) => [...row]);
    mismatch[2]![4] = "15700";
    const result = auditCashSheetRunningBalances(mismatch);
    expect(result.balanceMismatchRows).toBeGreaterThan(0);
    expect(result.balanceMismatchRowNumbers).toContain(3);
    const missing = rows.map((row) => [...row]);
    missing[3]![4] = "";
    expect(auditCashSheetRunningBalances(missing)).toMatchObject({
      checkedTransactions: 1, missingBalanceRows: 1,
    });
  });

  it("scopes row identity by account and configuration, preventing cross-account replay", () => {
    const first = planCashSheetImportDryRun(rows, scope);
    const accountChanged = planCashSheetImportDryRun(rows, { ...scope, accountId: 17 });
    const configChanged = planCashSheetImportDryRun(rows, { ...scope, configId: 3 });
    expect(first.proposed[0]?.sourceKey).not.toBe(accountChanged.proposed[0]?.sourceKey);
    expect(first.proposed[0]?.sourceKey).not.toBe(configChanged.proposed[0]?.sourceKey);
  });

  it("allows only aggregate diagnostics in the GET response, never raw fingerprints", () => {
    expect(routeSource).toContain("cashDryRun:");
    expect(routeSource).toContain('mode: "simulated_only_no_database_changes"');
    expect(routeSource).toContain("readyForCommit: false");
    expect(routeSource).not.toContain("res.json(initial.proposed)");
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
    expect(routeSource).toContain("openingBalanceMatchesAccount");
    expect(routeSource).toContain('databaseDuplicateCheck: "NOT_RUN_NO_MUTATIONS_READER_PRIVILEGE"');
    expect(routeSource).toContain("safeToImport: false");
  });
});
