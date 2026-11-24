import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  pool: { query: calls.query, connect: calls.connect },
}));
vi.mock("../lib/google-sheets", () => ({
  readSpreadsheetValues: calls.read,
  writeSpreadsheetValues: calls.write,
  spreadsheetCellRange: vi.fn(),
}));

import { syncOneBankSheetConfig, syncAllBankSheetConfigs } from "../lib/bank-sheet-sync";

describe("source-only DEV bank Sheet sync entrypoint lock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("denies a direct single-config call before DB or Google Sheets", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("BANK_SHEET_DEV_WRITES_ENABLED", "false");
    await expect(syncOneBankSheetConfig(2)).rejects.toThrow("BANK_SHEET_DEV_SOURCE_ONLY_READ_ONLY");
    expect(calls.query).not.toHaveBeenCalled();
    expect(calls.connect).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
    expect(calls.write).not.toHaveBeenCalled();
  });

  it("denies direct bulk sync by default before DB or Google Sheets", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("BANK_SHEET_DEV_WRITES_ENABLED", "");
    await expect(syncAllBankSheetConfigs(1)).rejects.toThrow("BANK_SHEET_DEV_SOURCE_ONLY_READ_ONLY");
    expect(calls.query).not.toHaveBeenCalled();
    expect(calls.connect).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
    expect(calls.write).not.toHaveBeenCalled();
  });
});
