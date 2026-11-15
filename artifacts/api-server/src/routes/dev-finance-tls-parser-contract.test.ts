import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMarketplaceFinanceDevDatabaseUrl } from "@workspace/db";

/**
 * Real node-postgres URL parser, with no network, database or real secrets.
 * The generated synthetic CA fixture is not a trusted certificate.
 */
describe("Finance DEV URL validation must agree with real pg parser", () => {
  // The runtime pg.Client exposes connectionParameters; @types/pg does not.
  // The explicit cast is confined to this constructor-only parser test.
  type ParsedConnection = {
    host: string;
    user: string;
    ssl: boolean | { ca?: string; rejectUnauthorized?: boolean };
  };
  const actualPgParser = (url: string): ParsedConnection =>
    (new pg.Client({ connectionString: url }) as unknown as {
      connectionParameters: ParsedConnection;
    }).connectionParameters;
  const role = "bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw";
  const host = "aws-0-ap-southeast-2.pooler.supabase.com";
  const base = "postgresql://" + role + ":synthetic@" + host + ":6543/postgres";
  const envNames = [
    "APP_ENV",
    "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
    "BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV",
    "BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV",
  ] as const;
  const original = Object.fromEntries(
    envNames.map(name => [name, process.env[name]]),
  ) as Record<(typeof envNames)[number], string | undefined>;
  let tempDirectory: string;
  let syntheticCA: string;
  beforeAll(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "finance-dev-url-contract-"));
    syntheticCA = join(tempDirectory, "synthetic-ca.crt");
    writeFileSync(syntheticCA, "TEST FIXTURE ONLY: not a valid CA certificate\n", { mode: 0o600 });
    process.env.APP_ENV = "development";
    process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "true";
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV;
  });
  afterEach(() => {
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
  });
  afterAll(() => {
    for (const key of envNames) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    rmSync(tempDirectory, { force: true, recursive: true });
  });
  const makeUrl = (params: Array<[string, string]>) => {
    const url = new URL(base);
    for (const [key, value] of params) url.searchParams.append(key, value);
    return url.toString();
  };
  const safeParams = (): Array<[string, string]> => [
    ["sslmode", "verify-full"],
    ["sslrootcert", syntheticCA],
  ];
  async function expectRejected(url: string) {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV = url;
    await expect(resolveMarketplaceFinanceDevDatabaseUrl())
      .rejects.toThrow("DEV_FINANCE_DATABASE_QUERY_PARAMS_INVALID");
  }

  it("catches trailing sslmode=disable which real pg would accept", async () => {
    const url = makeUrl([...safeParams(), ["sslmode", "disable"]]);
    const parsed = actualPgParser(url);
    expect(parsed.ssl).toBe(false);
    await expectRejected(url);
  });

  it("catches trailing sslmode=no-verify which disables certificate verification", async () => {
    const url = makeUrl([...safeParams(), ["sslmode", "no-verify"]]);
    const parsed = actualPgParser(url);
    expect((parsed.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(false);
    await expectRejected(url);
  });

  it("rejects duplicate CA parameters before passing them to pg", async () => {
    await expectRejected(makeUrl([...safeParams(), ["sslrootcert", "/dev/null"]]));
  });

  it("prevents driver host and user query overrides", async () => {
    const hostUrl = makeUrl([...safeParams(), ["host", "db.nzdweipzckfszczzqtuw.supabase.co"]]);
    const userUrl = makeUrl([...safeParams(), ["user", "postgres.xssrfshdrtdfupgqwfdw"]]);
    expect(actualPgParser(hostUrl).host)
      .toBe("db.nzdweipzckfszczzqtuw.supabase.co");
    expect(actualPgParser(userUrl).user)
      .toBe("postgres.xssrfshdrtdfupgqwfdw");
    await expectRejected(hostUrl);
    await expectRejected(userUrl);
  });

  it("preserves validated CA and dedicated identity in real pg parsing", async () => {
    const url = makeUrl(safeParams());
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV = url;
    expect(await resolveMarketplaceFinanceDevDatabaseUrl()).toBe(url);
    const parsed = actualPgParser(url);
    expect(parsed.host).toBe(host);
    expect(parsed.user).toBe(role);
    expect(parsed.ssl).toMatchObject({ ca: "TEST FIXTURE ONLY: not a valid CA certificate\n" });
    expect((parsed.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized).not.toBe(false);
  });
});
