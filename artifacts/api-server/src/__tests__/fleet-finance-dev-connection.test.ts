import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  options: vi.fn(), connect: vi.fn(), query: vi.fn(), release: vi.fn(), end: vi.fn(), on: vi.fn(),
  identity: {} as Record<string, unknown>, binding: { source_company_id: "1", finance_company_id: "3" },
  privilegesReady: true,
}));
vi.mock("pg", () => ({ default: { Pool: class {
  constructor(options: unknown) { database.options(options); }
  connect = database.connect;
  end = database.end;
  on = database.on;
} } }));

import {
  closeFleetFinanceDevPool, getFleetFinanceDevWriteReadiness,
  resolveFleetFinanceDevDatabaseUrl, withFleetFinanceDevTransaction,
} from "@workspace/db/fleet-finance-dev";

const directUrl = "postgresql://bizportal_fleet_finance_login_dev:synthetic@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/unavailable/public-ca.crt";
const poolerUrl = "postgresql://bizportal_fleet_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require";
const scope = { sourceCompanyId: 1, companyId: 3 };

beforeEach(async () => {
  await closeFleetFinanceDevPool();
  vi.resetAllMocks();
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("FLEET_FINANCE_DATABASE_ENABLED_DEV", "true");
  vi.stubEnv("FLEET_FINANCE_WRITE_ENABLED", "true");
  vi.stubEnv("FLEET_FINANCE_DATABASE_URL_DEV", directUrl);
  vi.stubEnv("FLEET_FINANCE_GCP_SECRET_NAME_DEV", "");
  database.identity = {
    db_role: "bizportal_fleet_finance_login_dev", login_role: "bizportal_fleet_finance_login_dev",
    database_name: "postgres", unsafe_role: false,
    companies_rls: true, source_rls: true, settings_rls: true, accounts_rls: true, journals_rls: true,
    entries_rls: true, lines_rls: true, ledger_rls: true, periods_rls: true,
  };
  database.binding = { source_company_id: "1", finance_company_id: "3" };
  database.privilegesReady = true;
  database.connect.mockResolvedValue({ query: database.query, release: database.release });
  database.query.mockImplementation(async (sql: string) => {
    if (sql.includes("current_user::text")) return { rows: [database.identity] };
    if (sql.includes("set_config")) return { rows: [database.binding] };
    if (sql.includes("AS privileges_ready")) return { rows: [{ privileges_ready: database.privilegesReady }] };
    return { rows: [], rowCount: 0 };
  });
});
afterEach(async () => { await closeFleetFinanceDevPool(); vi.unstubAllEnvs(); });

describe("dedicated Fleet Finance DEV connection", () => {
  it.each(["production", "", "test"])("refuses APP_ENV=%s before opening a connection", async (environment) => {
    vi.stubEnv("APP_ENV", environment);
    await expect(withFleetFinanceDevTransaction(scope, vi.fn())).rejects.toThrow("DATABASE_DISABLED");
    expect(database.options).not.toHaveBeenCalled();
  });

  it("requires the separate database enable flag", async () => {
    vi.stubEnv("FLEET_FINANCE_DATABASE_ENABLED_DEV", "false");
    await expect(withFleetFinanceDevTransaction(scope, vi.fn())).rejects.toThrow("DATABASE_DISABLED");
    expect(database.options).not.toHaveBeenCalled();
  });

  it.each([{ sourceCompanyId: 3, companyId: 3 }, { sourceCompanyId: 1, companyId: 1 }])("rejects unapproved company scope %j", async (invalid) => {
    await expect(withFleetFinanceDevTransaction(invalid, vi.fn())).rejects.toThrow("COMPANY_SCOPE_INVALID");
    expect(database.options).not.toHaveBeenCalled();
  });

  it("does not fall back to the shared database URL or secret", async () => {
    vi.stubEnv("FLEET_FINANCE_DATABASE_URL_DEV", "");
    vi.stubEnv("SUPABASE_DATABASE_URL_DEV", directUrl);
    vi.stubEnv("GCP_SECRET_MANAGER_SECRET_NAME_DEV", "cst-super-app-development");
    await expect(withFleetFinanceDevTransaction(scope, vi.fn())).rejects.toThrow("SECRET_NOT_CONFIGURED");
    expect(database.options).not.toHaveBeenCalled();
  });

  it("rejects two explicit credential sources instead of choosing one", async () => {
    vi.stubEnv("FLEET_FINANCE_GCP_SECRET_NAME_DEV", "bizportal-fleet-finance-dev");
    const reader = vi.fn();
    await expect(resolveFleetFinanceDevDatabaseUrl(reader)).rejects.toThrow("CREDENTIAL_SOURCE_AMBIGUOUS");
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    directUrl.replace("bizportal_fleet_finance_login_dev", "postgres"),
    directUrl.replace("bizportal_fleet_finance_login_dev", "bizportal_finance_diva_login_dev"),
    directUrl.replace("xssrfshdrtdfupgqwfdw", "nzdweipzckfszczzqtuw"),
    directUrl.replace("db.xssrfshdrtdfupgqwfdw.supabase.co", "example.invalid"),
    poolerUrl.replace(".xssrfshdrtdfupgqwfdw", ""),
    directUrl.replace("/postgres?", "/another_database?"),
    directUrl.replace(":5432/", ":9999/"),
    directUrl.replace("sslmode=verify-full", "sslmode=disable"),
  ])("rejects a wrong role, project, database, endpoint, port or TLS mode", async (url) => {
    vi.stubEnv("FLEET_FINANCE_DATABASE_URL_DEV", url);
    await expect(withFleetFinanceDevTransaction(scope, vi.fn())).rejects.toThrow(/DATABASE_(IDENTITY_INVALID|SSL_REQUIRED)/);
    expect(database.options).not.toHaveBeenCalled();
  });

  it("uses the existing pinned CA and a bounded pool with transaction-local company scope", async () => {
    const result = await withFleetFinanceDevTransaction(scope, async (client) => {
      expect(client.query).toBe(database.query);
      expect(database.query).toHaveBeenCalledWith(expect.stringContaining("app.fleet_source_company_id"), ["1", "3"]);
      return "posted";
    });
    expect(result).toBe("posted");
    expect(database.options).toHaveBeenCalledWith(expect.objectContaining({
      host: "db.xssrfshdrtdfupgqwfdw.supabase.co", database: "postgres", user: "bizportal_fleet_finance_login_dev",
      max: 2, application_name: "bizportal-fleet-finance-dev",
      ssl: expect.objectContaining({ rejectUnauthorized: true, servername: "db.xssrfshdrtdfupgqwfdw.supabase.co", ca: expect.stringContaining("BEGIN CERTIFICATE") }),
    }));
    expect(database.options.mock.calls[0][0]).not.toHaveProperty("connectionString");
    expect(database.query).toHaveBeenLastCalledWith("COMMIT");
    expect(database.release).toHaveBeenCalledWith(false);
  });

  it("keeps hostname verification for the project-bound pooler", async () => {
    vi.stubEnv("FLEET_FINANCE_DATABASE_URL_DEV", poolerUrl);
    await withFleetFinanceDevTransaction(scope, async () => null);
    expect(database.options).toHaveBeenCalledWith(expect.objectContaining({
      user: "bizportal_fleet_finance_login_dev.xssrfshdrtdfupgqwfdw", port: 6543,
      ssl: expect.objectContaining({ rejectUnauthorized: true, servername: "aws-0-ap-southeast-1.pooler.supabase.com", ca: expect.stringContaining("BEGIN CERTIFICATE") }),
    }));
  });

  it.each([
    { db_role: "postgres" }, { login_role: "bizportal_finance_diva_login_dev" },
    { unsafe_role: true }, { source_rls: false }, { ledger_rls: false }, { periods_rls: false },
  ])("rejects unverified database identity/RLS %j and rolls back before callback", async (change) => {
    Object.assign(database.identity, change);
    const work = vi.fn();
    await expect(withFleetFinanceDevTransaction(scope, work)).rejects.toThrow("ROLE_OR_RLS_UNVERIFIED");
    expect(work).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("rejects an incorrect transaction binding", async () => {
    database.binding.finance_company_id = "1";
    const work = vi.fn();
    await expect(withFleetFinanceDevTransaction(scope, work)).rejects.toThrow("TENANT_BINDING_FAILED");
    expect(work).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("allows a read-only transaction while refusing a disabled writer", async () => {
    vi.stubEnv("FLEET_FINANCE_WRITE_ENABLED", "false");
    await expect(withFleetFinanceDevTransaction(scope, vi.fn())).rejects.toThrow("WRITES_DISABLED");
    expect(database.connect).not.toHaveBeenCalled();
    await withFleetFinanceDevTransaction(scope, async () => null, { readOnly: true });
    expect(database.query).toHaveBeenNthCalledWith(1, "BEGIN READ ONLY");
  });

  it("rolls back a failed posting and releases its connection", async () => {
    await expect(withFleetFinanceDevTransaction(scope, async () => { throw new Error("posting failed"); })).rejects.toThrow("posting failed");
    expect(database.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(database.release).toHaveBeenCalledWith(false);
  });

  it("requires restart after an explicit credential changes", async () => {
    await withFleetFinanceDevTransaction(scope, async () => null);
    vi.stubEnv("FLEET_FINANCE_DATABASE_URL_DEV", directUrl.replace("synthetic", "rotated"));
    const work = vi.fn();
    await expect(withFleetFinanceDevTransaction(scope, work)).rejects.toThrow("CREDENTIAL_CHANGED_RESTART_REQUIRED");
    expect(work).not.toHaveBeenCalled();
    expect(database.connect).toHaveBeenCalledOnce();
  });

  it("coalesces dedicated GCP reads and never creates a pool for a failed secret lookup", async () => {
    vi.stubEnv("FLEET_FINANCE_DATABASE_URL_DEV", "");
    vi.stubEnv("FLEET_FINANCE_GCP_SECRET_NAME_DEV", "bizportal-fleet-finance-dev");
    const denied = vi.fn(async () => { throw new Error("GCP IAM denied"); });
    await expect(resolveFleetFinanceDevDatabaseUrl(denied)).rejects.toThrow("GCP IAM denied");
    const reader = vi.fn(async () => directUrl);
    expect(await Promise.all([resolveFleetFinanceDevDatabaseUrl(reader), resolveFleetFinanceDevDatabaseUrl(reader)])).toEqual([directUrl, directUrl]);
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith("bizportal-fleet-finance-dev", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(database.options).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports cash write readiness from actual ACL evidence: %s", async (privilegesReady) => {
    database.privilegesReady = privilegesReady;
    const result = await withFleetFinanceDevTransaction(scope, getFleetFinanceDevWriteReadiness, { readOnly: true });
    expect(result).toEqual({ writeEnabled: true, writeReady: privilegesReady, settingsReadOnly: true });
  });

  it("never reports a disabled writer ready", async () => {
    vi.stubEnv("FLEET_FINANCE_WRITE_ENABLED", "false");
    const result = await withFleetFinanceDevTransaction(scope, getFleetFinanceDevWriteReadiness, { readOnly: true });
    expect(result).toEqual({ writeEnabled: false, writeReady: false, settingsReadOnly: true });
    expect(database.query.mock.calls.some(([sql]) => sql.includes("privileges_ready"))).toBe(false);
  });
});
