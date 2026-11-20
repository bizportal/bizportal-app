import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poolSpy = vi.hoisted(() => ({
  create: vi.fn((url: string) => ({ url, end: vi.fn(async () => undefined) })),
}));
vi.mock("@workspace/db", () => ({
  createDedicatedPayrollPool: poolSpy.create,
}));
import { getDevBankSheetReader, closeDevBankSheetReaders } from "../lib/bankSheetScopedReader";

const cstUrl = "postgresql://bizportal_finance_cst_login_dev.xssrfshdrtdfupgqwfdw:isolated-only@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";
const divaUrl = "postgresql://bizportal_finance_diva_login_dev.xssrfshdrtdfupgqwfdw:isolated-only@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";

describe("PR147 dedicated DEV Sheet reader identity boundary", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", "");
    vi.stubEnv("PR147_BANK_SHEET_DIVA_DATABASE_URL_DEV", "");
    poolSpy.create.mockClear();
  });
  afterEach(async () => {
    await closeDevBankSheetReaders();
    vi.unstubAllEnvs();
  });
  it("denies missing credential, never creating a general OTP pool", () => {
    expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_NOT_CONFIGURED");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("denies unsupported company instead of routing into a broad reader", () => {
    expect(() => getDevBankSheetReader(99)).toThrow("PR147_DEV_SHEET_READER_COMPANY_UNSUPPORTED");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("denies using OTP role or wrong company Finance principal", () => {
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", cstUrl.replace("bizportal_finance_cst_login_dev","bizportal_pr81_otp_login_dev"));
    expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_IDENTITY_MISMATCH");
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", divaUrl);
    expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_IDENTITY_MISMATCH");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("denies non-DEV environment and wrong pooler", () => {
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", cstUrl);
    vi.stubEnv("APP_ENV","production");
    expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_ENVIRONMENT_REQUIRED");
    vi.stubEnv("APP_ENV","development");
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", cstUrl.replace("6543","5432"));
    expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_IDENTITY_MISMATCH");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("uses only the matching restricted company credential and caches each pool", () => {
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", cstUrl);
    vi.stubEnv("PR147_BANK_SHEET_DIVA_DATABASE_URL_DEV", divaUrl);
    const cst = getDevBankSheetReader(1);
    expect(getDevBankSheetReader(1)).toBe(cst);
    const diva = getDevBankSheetReader(3);
    expect(diva).not.toBe(cst);
    expect(poolSpy.create.mock.calls.map(x=>x[0])).toEqual([cstUrl,divaUrl]);
  });
});
