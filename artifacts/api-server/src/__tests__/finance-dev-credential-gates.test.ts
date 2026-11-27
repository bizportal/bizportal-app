import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveMarketplaceFinanceDevDatabaseUrl,
  withMarketplaceFinanceDevTransaction,
} from "@workspace/db";

const keys = [
  "APP_ENV", "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV",
] as const;
const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const syntheticUrl = "postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic-test-only@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require";

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.APP_ENV = "development";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV = syntheticUrl;
});
afterEach(() => {
  for (const key of keys) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

describe("Finance credential gate — independent approval-only mode", () => {
  it("resolves the DEV-only restricted credential with approval flags alone", async () => {
    process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV = "true";
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV = "true";
    expect(await resolveMarketplaceFinanceDevDatabaseUrl()).toBe(syntheticUrl);
    await expect(withMarketplaceFinanceDevTransaction(1, async () => null))
      .rejects.toThrow("DEV_FINANCE_WRITER_DISABLED");
    await expect(withMarketplaceFinanceDevTransaction(1, async () => null, { readOnly: true }))
      .rejects.toThrow("DEV_FINANCE_READER_DISABLED");
  });

  it("keeps the credential resolver disabled without either full approval flag or read flag", async () => {
    process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV = "true";
    const secretReader = vi.fn(async () => syntheticUrl);
    await expect(resolveMarketplaceFinanceDevDatabaseUrl(secretReader))
      .rejects.toThrow("DEV_FINANCE_DISABLED");
    expect(secretReader).not.toHaveBeenCalled();
  });

  it("permits independent read-only mode without enabling writes", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV = "true";
    expect(await resolveMarketplaceFinanceDevDatabaseUrl()).toBe(syntheticUrl);
    await expect(withMarketplaceFinanceDevTransaction(1, async () => null))
      .rejects.toThrow("DEV_FINANCE_WRITER_DISABLED");
  });

  it("never accepts PROD or a cross-environment database", async () => {
    process.env.APP_ENV = "production";
    process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV = "true";
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV = "true";
    await expect(resolveMarketplaceFinanceDevDatabaseUrl()).rejects.toThrow("DEV_FINANCE_DISABLED");
    process.env.APP_ENV = "development";
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      syntheticUrl.replace("xssrfshdrtdfupgqwfdw", "nzdweipzckfszczzqtuw");
    await expect(resolveMarketplaceFinanceDevDatabaseUrl()).rejects.toThrow("DEV_FINANCE_DATABASE_IDENTITY_INVALID");
  });
});
