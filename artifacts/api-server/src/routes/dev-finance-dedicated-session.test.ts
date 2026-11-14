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

import { withMarketplaceFinanceDevTransaction, onMarketplaceFinanceCommit } from "@workspace/db";

const KEYS = [
  "APP_ENV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV",
] as const;
const originals = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

describe("dedicated Finance DEV database transaction boundary", () => {
  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
    process.env.APP_ENV = "development";
    process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "true";
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require";
    mock.options.mockClear();
    mock.execute.mockReset();
    mock.scopedCompany = "";
    mock.role = "bizportal_marketplace_finance_login_dev";
    mock.elevated = false;
    mock.rls = true;
    mock.execute.mockImplementation(async (query: unknown) => {
      const statement = new PgDialect().sqlToQuery(query as any);
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
  it("rejects privileged postgres as a finance credential", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://postgres.xssrfshdrtdfupgqwfdw:fake@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require";
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
  it("never opens Finance in PROD, regardless of its feature flag", async () => {
    process.env.APP_ENV = "production";
    await expect(withMarketplaceFinanceDevTransaction(1, async () => 1))
      .rejects.toThrow("DEV_FINANCE_DISABLED");
  });
  it("sets the verified tenant on the same bounded transaction and uses no shared pool", async () => {
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      "postgresql://bizportal_marketplace_finance_login_dev.xssrfshdrtdfupgqwfdw:synthetic@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require";
    const result = await withMarketplaceFinanceDevTransaction(1, async (scoped) => {
      expect(scoped).toBe(mock.session);
      expect(mock.scopedCompany).toBe("1");
      return { accepted: true };
    });
    expect(result).toEqual({ accepted: true });
    expect(mock.options).toHaveBeenCalledWith(expect.objectContaining({ max: 1 }));
    expect(mock.execute).toHaveBeenCalledTimes(3);
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
});
