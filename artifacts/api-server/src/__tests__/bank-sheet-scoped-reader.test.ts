import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const poolSpy = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  readSecret: vi.fn(async () => { throw Error("NOT_CONFIGURED_FOR_ISOLATED_TEST"); }),
}));
vi.mock("pg", () => ({
  Pool: class {
    end = vi.fn(async () => undefined);
    constructor(options: unknown) { poolSpy.create(options); }
  },
}));
import { getDevBankSheetReader, getDevBankSheetReaderFromConfiguredSource, closeDevBankSheetReaders } from "../lib/bankSheetScopedReader";

const cstUrl = "postgresql://bizportal_finance_cst_login_dev.xssrfshdrtdfupgqwfdw:isolated-only@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full";
const divaUrl = "postgresql://bizportal_finance_diva_login_dev.xssrfshdrtdfupgqwfdw:isolated-only@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full";

describe("PR147 dedicated DEV Sheet reader identity boundary", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", "");
    vi.stubEnv("PR147_BANK_SHEET_DIVA_DATABASE_URL_DEV", "");
    vi.stubEnv("PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV", "");
    vi.stubEnv("PR147_BANK_SHEET_DIVA_GCP_SECRET_NAME_DEV", "");
    vi.stubEnv("PR147_BANK_SHEET_COMPANIES_GCP_SECRET_NAME_DEV", "");
    poolSpy.create.mockClear();
  });
  afterEach(async () => {
    await closeDevBankSheetReaders();
    vi.unstubAllEnvs();
  });
  it("uses the existing scoped company bundle without copying or rotating credentials", async () => {
    vi.stubEnv("PR147_BANK_SHEET_COMPANIES_GCP_SECRET_NAME_DEV","bizportal-marketplace-finance-dev-companies");
    const fetchBundle=vi.fn(async () => JSON.stringify({
      version:2,
      companies: {
        "1": {role:"bizportal_finance_cst_login_dev",databaseUrl:cstUrl},
        "3": {role:"bizportal_finance_diva_login_dev",databaseUrl:divaUrl},
      }
    }));
    const cst=await getDevBankSheetReaderFromConfiguredSource(1,fetchBundle);
    const diva=await getDevBankSheetReaderFromConfiguredSource(3,fetchBundle);
    expect(cst).toBeDefined();
    expect(diva).not.toBe(cst);
    expect(fetchBundle).toHaveBeenCalledTimes(2);
    expect(fetchBundle).toHaveBeenNthCalledWith(1,"bizportal-marketplace-finance-dev-companies");
    expect(poolSpy.create).toHaveBeenCalledTimes(2);
  });
  it("refuses a wrong role label even if the URL username looks correct", async () => {
    vi.stubEnv("PR147_BANK_SHEET_COMPANIES_GCP_SECRET_NAME_DEV","bizportal-marketplace-finance-dev-companies");
    const source=vi.fn(async()=>JSON.stringify({companies:{"1":{
      role:"bizportal_finance_diva_login_dev",databaseUrl:cstUrl
    }}}));
    await expect(getDevBankSheetReaderFromConfiguredSource(1,source))
      .rejects.toThrow("PR147_DEV_SHEET_READER_BUNDLE_COMPANY_IDENTITY_MISMATCH");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("refuses missing tenant, malformed bundle and non-approved source names", async () => {
    vi.stubEnv("PR147_BANK_SHEET_COMPANIES_GCP_SECRET_NAME_DEV","bizportal-marketplace-finance-dev-companies");
    await expect(getDevBankSheetReaderFromConfiguredSource(3,async()=>JSON.stringify({companies:{
      "1":{role:"bizportal_finance_cst_login_dev",databaseUrl:cstUrl}
    }}))).rejects.toThrow("PR147_DEV_SHEET_READER_BUNDLE_COMPANY_IDENTITY_MISMATCH");
    await expect(getDevBankSheetReaderFromConfiguredSource(1,async()=>"{invalid"))
      .rejects.toThrow("PR147_DEV_SHEET_READER_BUNDLE_INVALID");
    vi.stubEnv("PR147_BANK_SHEET_COMPANIES_GCP_SECRET_NAME_DEV","bizportal-production");
    await expect(getDevBankSheetReaderFromConfiguredSource(1,async()=>"unused"))
      .rejects.toThrow("PR147_DEV_SHEET_READER_BUNDLE_NAME_INVALID");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("forbids bundle-plus-direct or bundle-plus-dedicated secret ambiguities", async () => {
    vi.stubEnv("PR147_BANK_SHEET_COMPANIES_GCP_SECRET_NAME_DEV","bizportal-marketplace-finance-dev-companies");
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV",cstUrl);
    await expect(getDevBankSheetReaderFromConfiguredSource(1,async()=>"unused"))
      .rejects.toThrow("PR147_DEV_SHEET_READER_CREDENTIAL_SOURCE_AMBIGUOUS");
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV","");
    vi.stubEnv("PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV","bizportal-pr147-bank-sheet-cst-dev");
    await expect(getDevBankSheetReaderFromConfiguredSource(1,async()=>"unused"))
      .rejects.toThrow("PR147_DEV_SHEET_READER_CREDENTIAL_SOURCE_AMBIGUOUS");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("reads only the named dedicated CST secret, never the OTP pool", async () => {
    const reader = vi.fn(async (_name: string) => cstUrl);
    vi.stubEnv("PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV","bizportal-pr147-bank-sheet-cst-dev");
    const scoped = await getDevBankSheetReaderFromConfiguredSource(1,reader);
    expect(scoped).toBeDefined();
    expect(reader).toHaveBeenCalledWith("bizportal-pr147-bank-sheet-cst-dev");
    expect(poolSpy.create).toHaveBeenCalledTimes(1);
  });
  it("forbids conflicting direct and secret credentials before loading secrets", async () => {
    const reader = vi.fn(async () => cstUrl);
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV",cstUrl);
    vi.stubEnv("PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV","bizportal-pr147-bank-sheet-cst-dev");
    await expect(getDevBankSheetReaderFromConfiguredSource(1,reader))
      .rejects.toThrow("PR147_DEV_SHEET_READER_CREDENTIAL_SOURCE_AMBIGUOUS");
    expect(reader).not.toHaveBeenCalled();
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("forbids other secret names and wrong-company payloads", async () => {
    const reader = vi.fn(async () => divaUrl);
    vi.stubEnv("PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV","shared-production-secret");
    await expect(getDevBankSheetReaderFromConfiguredSource(1,reader))
      .rejects.toThrow("PR147_DEV_SHEET_READER_SECRET_NAME_INVALID");
    vi.stubEnv("PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV","bizportal-pr147-bank-sheet-cst-dev");
    await expect(getDevBankSheetReaderFromConfiguredSource(1,reader))
      .rejects.toThrow("PR147_DEV_SHEET_READER_IDENTITY_MISMATCH");
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("does not fall back on Secret Manager errors", async () => {
    const reader = vi.fn(async () => { throw Error("GCP_SECRET_UNAVAILABLE"); });
    vi.stubEnv("PR147_BANK_SHEET_CST_GCP_SECRET_NAME_DEV","bizportal-pr147-bank-sheet-cst-dev");
    await expect(getDevBankSheetReaderFromConfiguredSource(1,reader))
      .rejects.toThrow("GCP_SECRET_UNAVAILABLE");
    expect(poolSpy.create).not.toHaveBeenCalled();
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
    ]) {
      vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV", url);
      expect(() => getDevBankSheetReader(1)).toThrow("PR147_DEV_SHEET_READER_TLS_REQUIRED");
    }
    expect(poolSpy.create).not.toHaveBeenCalled();
  });
  it("ignores legacy sslrootcert hint while pinning system TLS identity", () => {
    vi.stubEnv("PR147_BANK_SHEET_CST_DATABASE_URL_DEV",cstUrl+"&sslrootcert=/tmp/untrusted");
    expect(getDevBankSheetReader(1)).toBeDefined();
    expect(poolSpy.create).toHaveBeenCalledTimes(1);
    const opts=poolSpy.create.mock.calls[0][0] as Record<string,unknown>;
    expect(opts.ssl).toEqual({
      rejectUnauthorized:true,servername:"aws-1-ap-southeast-2.pooler.supabase.com"
    });
    expect(Object.keys(opts)).not.toContain("sslrootcert");
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
