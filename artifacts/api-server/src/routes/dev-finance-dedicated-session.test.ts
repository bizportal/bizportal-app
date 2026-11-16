import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mock = vi.hoisted(() => ({
  options: vi.fn(),
  execute: vi.fn(),
  scopedCompany: "",
  role: "bizportal_marketplace_finance_login_dev",
  elevated: false,
  rls: true,
  session: null as any,
}));
vi.mock("pg", () => ({
  default: { Pool: class {
    constructor(options: unknown) { mock.options(options); }
  } },
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => ({
    transaction: async (work: (tx: any) => Promise<any>) => {
      const tx = {
        execute: mock.execute,
        transaction: async (nested: (tx: any) => Promise<any>) => nested(tx),
      };
      mock.session = tx;
      return work(tx);
    },
  }),
}));

import { withMarketplaceFinanceDevTransaction, withMarketplaceFinanceDevReadOnlyTransaction, onMarketplaceFinanceCommit, resolveMarketplaceFinanceDevDatabaseUrl } from "@workspace/db";

const KEYS = [
  "APP_ENV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV",
] as const;
const originals = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

describe("dedicated Finance DEV database transaction boundary", () => {
  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
    process.env.APP_ENV = "development";
    process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "true";
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://bizportal_marketplace_finance_login_dev:synthetic@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/opt/cst-dev-finance-tls/supabase-root-2021.crt";
    mock.options.mockClear();
    mock.execute.mockReset();
    mock.scopedCompany = "";
    mock.role = "bizportal_marketplace_finance_login_dev";
    mock.elevated = false;
    mock.rls = true;
    mock.execute.mockImplementation(async (query: unknown) => {
      const statement = new PgDialect().sqlToQuery(query as any);
      if (statement.sql.trim().toUpperCase() === "SET TRANSACTION READ ONLY") {
        return { rows: [] };
      }
      if (statement.sql.includes("current_user::text")) {
        return { rows: [{
          db_role: mock.role, login_role: mock.role,
          elevated: mock.elevated,
          po_rls: mock.rls, po_lines_rls: mock.rls,
          shipments_rls: mock.rls, shipment_items_rls: mock.rls,
          receipts_rls: mock.rls, receipt_items_rls: mock.rls,
          invoice_rls: mock.rls, invoice_lines_rls: mock.rls,
          ap_rls: mock.rls, payment_rls: mock.rls, handoff_rls: mock.rls,
        }] };
      }
      if (statement.sql.includes("set_config")) {
        expect(statement.sql).toContain("true");
        mock.scopedCompany = String(statement.params[0]);
        return { rows: [{ set_config: mock.scopedCompany }] };
      }
      if (statement.sql.includes("current_setting")) {
        return { rows: [{ company_id: mock.scopedCompany }] };
      }
      throw Error("Unexpected SQL");
    });
  });
  afterEach(() => {
    for (const key of KEYS) {
      const value = originals[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does not use the ordinary DEV postgres URL as a fallback", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
    await expect(withMarketplaceFinanceDevTransaction(1, async () => 1))
      .rejects.toThrow("DEV_FINANCE_CREDENTIAL_NOT_CONFIGURED");
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("accepts only an explicitly selected dedicated GCP finance secret", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV =
      "bizportal-marketplace-finance-dev-unit";
    const reader=vi.fn(async()=>
      "postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt");
    const url=await resolveMarketplaceFinanceDevDatabaseUrl(reader);
    expect(new URL(url).username).toBe("bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw");
    expect(reader).toHaveBeenCalledWith("bizportal-marketplace-finance-dev-unit");
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("fails closed with the real GCP reader when bootstrap credentials are absent", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV =
      "bizportal-marketplace-finance-dev-no-bootstrap";
    const original = process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON;
    try {
      delete process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON;
      await expect(resolveMarketplaceFinanceDevDatabaseUrl())
        .rejects.toThrow("GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not configured");
      expect(mock.options).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON;
      else process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON = original;
    }
  });
  it("rejects use of the generic shared database secret for Finance", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV =
      "cst-super-app-development";
    const reader=vi.fn();
    await expect(resolveMarketplaceFinanceDevDatabaseUrl(reader))
      .rejects.toThrow("DEV_FINANCE_SECRET_NAME_INVALID");
    expect(reader).not.toHaveBeenCalled();
  });
  it("rejects ambiguous direct URL and secret sources", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV =
      "bizportal-marketplace-finance-dev";
    const reader=vi.fn();
    await expect(resolveMarketplaceFinanceDevDatabaseUrl(reader))
      .rejects.toThrow("DEV_FINANCE_CREDENTIAL_SOURCE_AMBIGUOUS");
    expect(reader).not.toHaveBeenCalled();
  });
  it("does not silently fall back to postgres when Secret Manager fails", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV =
      "bizportal-marketplace-finance-dev-unavailable";
    const reader=vi.fn(async()=>{throw new Error("simulated GCP IAM denial")});
    await expect(resolveMarketplaceFinanceDevDatabaseUrl(reader))
      .rejects.toThrow("simulated GCP IAM denial");
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("rejects privileged postgres as a finance credential", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://postgres.xssrfshdrtdfupgqwfdw:fake@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt";
    await expect(withMarketplaceFinanceDevTransaction(1, async () => 1))
      .rejects.toThrow("DEV_FINANCE_DATABASE_IDENTITY_INVALID");
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("requires TLS before any dedicated Finance DB connection is created", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";
    await expect(withMarketplaceFinanceDevTransaction(1, async () => 1))
      .rejects.toThrow("DEV_FINANCE_DATABASE_SSL_REQUIRED");
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("rejects sslmode=require even though pg v8 currently aliases it to verify-full", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require";
    await expect(resolveMarketplaceFinanceDevDatabaseUrl())
      .rejects.toThrow("DEV_FINANCE_DATABASE_VERIFIED_CA_REQUIRED");
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("rejects verify-full without an explicit trusted server CA path", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=verify-full";
    await expect(resolveMarketplaceFinanceDevDatabaseUrl())
      .rejects.toThrow("DEV_FINANCE_DATABASE_VERIFIED_CA_REQUIRED");
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("rejects verify-ca and relative CA paths that do not verify hostname reliably", async () => {
    const base="postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres";
    for (const [query, code] of [
      ["sslmode=verify-ca&sslrootcert=/trusted/synthetic-supabase-ca.crt", "DEV_FINANCE_DATABASE_VERIFIED_CA_REQUIRED"],
      ["sslmode=verify-full&sslrootcert=relative-ca.crt", "DEV_FINANCE_DATABASE_VERIFIED_CA_REQUIRED"],
      ["sslmode=require&uselibpqcompat=true&sslrootcert=/trusted/synthetic-supabase-ca.crt", "DEV_FINANCE_DATABASE_QUERY_PARAMS_INVALID"],
    ]) {
      process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV = base+"?"+query;
      await expect(resolveMarketplaceFinanceDevDatabaseUrl())
        .rejects.toThrow(code);
    }
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("accepts explicit verify-full and absolute CA path only for the CST-DEV Finance role", async () => {
    const url = await resolveMarketplaceFinanceDevDatabaseUrl();
    const parsed = new URL(url);
    expect(parsed.searchParams.get("sslmode")).toBe("verify-full");
    expect(parsed.searchParams.get("sslrootcert")).toBe("/opt/cst-dev-finance-tls/supabase-root-2021.crt");
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("rejects duplicated TLS settings and any driver-level host/user override", async () => {
    const base="postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres";
    for (const suffix of [
      "sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt&sslmode=disable",
      "sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt&sslmode=no-verify",
      "sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt&sslrootcert=/dev/null",
      "sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt&user=postgres.xssrfshdrtdfupgqwfdw",
      "sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt&host=db.nzdweipzckfszczzqtuw.supabase.co",
      "sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt&ssl=0",
      "sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt&uselibpqcompat=true",
    ]) {
      process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV = base+"?"+suffix;
      await expect(resolveMarketplaceFinanceDevDatabaseUrl())
        .rejects.toThrow("DEV_FINANCE_DATABASE_QUERY_PARAMS_INVALID");
    }
    expect(mock.options).not.toHaveBeenCalled();
  });
  it("never opens Finance in PROD, regardless of its feature flag", async () => {
    process.env.APP_ENV = "production";
    await expect(withMarketplaceFinanceDevTransaction(1, async () => 1))
      .rejects.toThrow("DEV_FINANCE_DISABLED");
  });
  it("sets the verified tenant on the same bounded transaction and uses no shared pool", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://bizportal_marketplace_finance_login_dev:synthetic@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/opt/cst-dev-finance-tls/supabase-root-2021.crt";
    const result = await withMarketplaceFinanceDevTransaction(1, async (scoped) => {
      expect(scoped).toBe(mock.session);
      expect(mock.scopedCompany).toBe("1");
      return { accepted: true };
    });
    expect(result).toEqual({ accepted: true });
    expect(mock.options).toHaveBeenCalledWith(expect.objectContaining({
      max: 1,
      host: "db.xssrfshdrtdfupgqwfdw.supabase.co",
      port: 5432,
      user: "bizportal_marketplace_finance_login_dev",
      database: "postgres",
      ssl: expect.objectContaining({
        rejectUnauthorized: true,
        servername: "db.xssrfshdrtdfupgqwfdw.supabase.co",
        ca: expect.stringContaining("-----BEGIN CERTIFICATE-----"),
      }),
    }));
    const options = mock.options.mock.calls[0]?.[0] as Record<string, any>;
    expect(options).not.toHaveProperty("connectionString");
    expect(options.ssl.ca).toContain("-----END CERTIFICATE-----");
    expect(mock.execute).toHaveBeenCalledTimes(3);
  });
  it("enforces read-only SQL as the FIRST query even when the Writer flag is OFF", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV = "true";
    const result = await withMarketplaceFinanceDevReadOnlyTransaction(1, async () => "read-ok");
    expect(result).toBe("read-ok");
    const queries = mock.execute.mock.calls.map(([query]) =>
      new PgDialect().sqlToQuery(query as any).sql);
    expect(queries[0].trim().toUpperCase()).toBe("SET TRANSACTION READ ONLY");
    expect(queries[1]).toContain("current_user::text");
    expect(queries.some(query => query.includes("set_config"))).toBe(true);
    expect(queries.some(query => query.includes("current_setting"))).toBe(true);
  });
  it("never enables the canonical writer helper merely because read-only Finance is on", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV = "true";
    const callback = vi.fn();
    await expect(withMarketplaceFinanceDevTransaction(1, callback))
      .rejects.toThrow("DEV_FINANCE_WRITER_DISABLED");
    expect(callback).not.toHaveBeenCalled();
    expect(mock.execute).not.toHaveBeenCalled();
  });
  it("blocks queued after-commit actions in the read-only Finance helper", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV = "true";
    const notify = vi.fn();
    await expect(withMarketplaceFinanceDevReadOnlyTransaction(1, async (session) => {
      onMarketplaceFinanceCommit(session, notify);
      return true;
    })).rejects.toThrow("DEV_FINANCE_READ_ONLY_SIDE_EFFECT_DENIED");
    expect(notify).not.toHaveBeenCalled();
  });
  it("rejects all Finance bootstrap when both independent flags are OFF", async () => {
    delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV;
    await expect(resolveMarketplaceFinanceDevDatabaseUrl())
      .rejects.toThrow("DEV_FINANCE_DISABLED");
  });
  it("runs deferred Finance audit only after the outer transaction succeeds", async () => {
    const events: string[] = [];
    await withMarketplaceFinanceDevTransaction(1, async (session) => {
      onMarketplaceFinanceCommit(session, () => { events.push("audit-after-commit"); });
      events.push("inside-transaction");
      expect(events).toEqual(["inside-transaction"]);
      return null;
    });
    expect(events).toEqual(["inside-transaction", "audit-after-commit"]);
  });
  it("drops deferred audit/notification if the outer transaction rolls back", async () => {
    const audit = vi.fn();
    await expect(withMarketplaceFinanceDevTransaction(1, async (session) => {
      onMarketplaceFinanceCommit(session, audit);
      throw new Error("simulated outer rollback");
    })).rejects.toThrow("simulated outer rollback");
    expect(audit).not.toHaveBeenCalled();
  });
  it("rejects BYPASSRLS even when the credential originally passed validation", async () => {
    mock.elevated = true;
    const callback = vi.fn();
    await expect(withMarketplaceFinanceDevTransaction(1, callback))
      .rejects.toThrow("DEV_FINANCE_ROLE_OR_RLS_UNVERIFIED");
    expect(callback).not.toHaveBeenCalled();
  });
  it("rejects missing RLS without invoking the canonical writer", async () => {
    mock.rls = false;
    const callback = vi.fn();
    await expect(withMarketplaceFinanceDevTransaction(1, callback))
      .rejects.toThrow("DEV_FINANCE_ROLE_OR_RLS_UNVERIFIED");
    expect(callback).not.toHaveBeenCalled();
  });
  it("fails closed on credential rotation instead of silently reusing an old pool", async () => {
    // A prior test already initialized the session pool with the synthetic
    // dedicated identity; changing the credential must require a restart.
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic-rotated@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert=/trusted/synthetic-supabase-ca.crt";
    const writer = vi.fn();
    await expect(withMarketplaceFinanceDevTransaction(1, writer))
      .rejects.toThrow("DEV_FINANCE_CREDENTIAL_CHANGED_RESTART_REQUIRED");
    expect(writer).not.toHaveBeenCalled();
    expect(mock.options).not.toHaveBeenCalled();
  });
});
