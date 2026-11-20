import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poolSpy = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: class {
    end = vi.fn(async () => undefined);
    constructor(options: unknown) { poolSpy.create(options); }
  },
}));
import { getDevBankSheetReader, closeDevBankSheetReaders } from "../lib/bankSheetScopedReader";

const cstUrl = "postgresql://bizportal_finance_cst_login_dev.xssrfshdrtdfupgqwfdw:isolated-only@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full";
const divaUrl = "postgresql://bizportal_finance_diva_login_dev.xssrfshdrtdfupgqwfdw:isolated-only@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full";

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
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", cstUrl.replace("6543","6432"));
    expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_IDENTITY_MISMATCH");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("accepts the active CST-DEV Supavisor session endpoint as well as transaction mode", () => {
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", cstUrl.replace("6543","5432"));
    expect(getDevBankSheetReader(1)).toBeDefined();
    expect(poolSpy.create).toHaveBeenCalledTimes(1);
  });
  it("denies a wrong regional Supavisor endpoint even with the same username", () => {
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", cstUrl.replace("ap-southeast-2","ap-southeast-1"));
    expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_IDENTITY_MISMATCH");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("rejects absent, disabled or overridden TLS before opening a pool", () => {
    for (const url of [
      cstUrl.replace("?sslmode=verify-full", ""),
      cstUrl.replace("verify-full", "disable"),
      cstUrl+"&host=evil.example",
      cstUrl+"&sslrootcert=/tmp/untrusted",
    ]) {
      vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", url);
      expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_TLS_REQUIRED");
    }
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("rejects hot credential rotation without changing the live pool", () => {
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV",cstUrl);
    const first=getDevBankSheetReader(1);
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV",cstUrl.replace("isolated-only","rotated-fixture"));
    expect(()=>getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_CREDENTIAL_CHANGED_RESTART_REQUIRED");
    expect(poolSpy.create).toHaveBeenCalledTimes(1);
    expect(first).toBeDefined();
  });
  it("uses only the matching restricted company credential and caches each pool", () => {
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", cstUrl);
    vi.stubEnv("PR147_BANK_SHEET_DIVA_DATABASE_URL_DEV", divaUrl);
    const cst = getDevBankSheetReader(1);
    expect(getDevBankSheetReader(1)).toBe(cst);
    const diva = getDevBankSheetReader(3);
    expect(diva).not.toBe(cst);
    const opts = poolSpy.create.mock.calls.map(x=>x[0] as Record<string,unknown>);
    expect(opts.map(x=>x.user)).toEqual([
      "bizportal_finance_cst_login_dev.xssrfshdrtdfupgqwfdw",
      "bizportal_finance_diva_login_dev.xssrfshdrtdfupgqwfdw",
    ]);
    expect(opts.every(x=>JSON.stringify(x.ssl) === JSON.stringify({
      rejectUnauthorized:true,servername:"aws-1-ap-southeast-2.pooler.supabase.com"
    }))).toBe(true);
  });
});
