import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  sql: [] as string[],
  params: [] as unknown[][],
  bound: "",
  role: "bizportal_marketplace_finance_login_dev",
  tls: true,
  rls: true,
  readOnly: "on",
  releases: 0,
  closes: 0,
  options: null as any,
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(options: unknown) { fake.options = options; }
      async connect() {
        return {
          connection: { stream: { encrypted: fake.tls, authorized: fake.tls } },
          query: async (statement: string, args: unknown[] = []) => {
            fake.sql.push(statement);
            fake.params.push(args);
            if (statement.includes("SELECT current_user::text")) {
              const attrs: Record<string, unknown> = {
                db_role: fake.role, login_role: fake.role,
                elevated: false, read_only: fake.readOnly,
              };
              for (const key of ["po","po_lines","shipments","shipment_items","receipts",
                "receipt_items","vi","vi_lines","ap","payment","handoff"]) {
                attrs["rls_" + key] = fake.rls;
              }
              return { rows: [attrs] };
            }
            if (statement.includes("SELECT set_config(")) {
              fake.bound = String(args[0]);
              return { rows: [{ set_config: fake.bound }] };
            }
            if (statement.includes("SELECT current_setting(")) {
              return { rows: [{ tenant: fake.bound }] };
            }
            if (statement.includes("count(*)::int FROM public.mkt_purchase_orders")) {
              return {
                rows: [{
                  po_count: fake.bound === "1" ? 2 : 1,
                  invoice_count: fake.bound === "1" ? 1 : 0,
                  ap_count: 0, handoff_count: 0,
                }],
              };
            }
            if (/^\s*(BEGIN READ ONLY|SET LOCAL statement_timeout|ROLLBACK)\b/.test(statement)) {
              return { rows: [] };
            }
            throw Error("UNEXPECTED_SQL");
          },
          release: () => { fake.releases++; },
        };
      }
      async end() { fake.closes++; }
    },
  },
}));
import {
  readMarketplaceFinanceSummaryDev,
  resolveMarketplaceFinanceDevDatabaseUrl,
} from "@workspace/db";

const DEV = "xssrfshdrtdfupgqwfdw";
const FINANCE_URL = "postgresql://bizportal_marketplace_finance_login_dev:" +
  "synthetic@db." + DEV + ".supabase.co:5432/postgres" +
  "?sslmode=verify-full&sslrootcert=/etc/ssl/certs/cst-dev-supabase-root.crt";
const keys = ["APP_ENV","BIZPORTAL_FINANCE_READONLY_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV",
  "BIZPORTAL_FINANCE_READONLY_COMPANY_IDS_DEV"] as const;
const saved = Object.fromEntries(keys.map(x => [x,process.env[x]]));
beforeEach(() => {
  process.env.APP_ENV = "development";
  process.env.BIZPORTAL_FINANCE_READONLY_ENABLED_DEV = "true";
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "false";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV = FINANCE_URL;
  process.env.BIZPORTAL_FINANCE_READONLY_COMPANY_IDS_DEV = "1,3";
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV;
  fake.sql = [];
  fake.params = [];
  fake.bound = "";
  fake.role = "bizportal_marketplace_finance_login_dev";
  fake.tls = true;
  fake.rls = true;
  fake.readOnly = "on";
  fake.releases = 0;
  fake.closes = 0;
  fake.options = null;
});
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("CST-DEV Finance summary uses one fail-closed READ ONLY transaction", () => {
  it("reads two separate allowlisted tenants, never writes, rolls back and closes", async () => {
    const a = await readMarketplaceFinanceSummaryDev(1);
    const b = await readMarketplaceFinanceSummaryDev(3);
    expect(a).toEqual({companyId:1,purchaseOrders:2,vendorInvoices:1,
      apPreparations:0,accountingHandoffs:0});
    expect(b).toEqual({companyId:3,purchaseOrders:1,vendorInvoices:0,
      apPreparations:0,accountingHandoffs:0});
    expect(fake.params.filter((args) => args.length).map(args => args[0])).toEqual(["1","3"]);
    expect(fake.sql.filter(x => x === "BEGIN READ ONLY")).toHaveLength(2);
    expect(fake.sql.filter(x => x === "ROLLBACK")).toHaveLength(2);
    expect(fake.sql.every(x => /^(SELECT|\s*SELECT|BEGIN READ ONLY|SET LOCAL statement_timeout|ROLLBACK)/.test(x))).toBe(true);
    expect(fake.releases).toBe(2);
    expect(fake.closes).toBe(2);
    expect(fake.options.ssl.rejectUnauthorized).toBe(true);
    expect(fake.options.ssl.ca).toContain("BEGIN CERTIFICATE");
    expect(fake.options.max).toBe(1);
  });
  it("does not allow unapproved or unbound company", async () => {
    await expect(readMarketplaceFinanceSummaryDev(0)).rejects.toThrow();
    await expect(readMarketplaceFinanceSummaryDev(2)).rejects.toThrow();
    await expect(readMarketplaceFinanceSummaryDev(999)).rejects.toThrow();
    expect(fake.sql).toHaveLength(0);
  });
  it("does not start read-only mode if writer is enabled", async () => {
    process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "true";
    await expect(readMarketplaceFinanceSummaryDev(1)).rejects.toThrow();
    expect(fake.sql).toHaveLength(0);
  });
  it.each(["production", "staging"])("never connects outside DEV environment %s", async env => {
    process.env.APP_ENV = env;
    await expect(readMarketplaceFinanceSummaryDev(1)).rejects.toThrow();
    expect(fake.sql).toHaveLength(0);
  });
  it("rejects incorrect DB role before reading tenant data", async () => {
    fake.role = "postgres";
    await expect(readMarketplaceFinanceSummaryDev(1)).rejects.toThrow("DEV_FINANCE_READONLY_ROLE_OR_RLS_UNVERIFIED");
    expect(fake.sql.some(x => x.includes("count(*)::int FROM public.mkt_purchase_orders"))).toBe(false);
    expect(fake.sql).toContain("ROLLBACK");
  });
  it("rejects missing RLS or backend read-only status", async () => {
    fake.rls = false;
    await expect(readMarketplaceFinanceSummaryDev(1)).rejects.toThrow();
    fake.rls = true;
    fake.readOnly = "off";
    await expect(readMarketplaceFinanceSummaryDev(1)).rejects.toThrow();
    expect(fake.releases).toBe(2);
    expect(fake.closes).toBe(2);
  });
  it("rejects missing TLS verification before BEGIN", async () => {
    fake.tls = false;
    await expect(readMarketplaceFinanceSummaryDev(1)).rejects.toThrow("DEV_FINANCE_READONLY_TLS_NOT_VERIFIED");
    expect(fake.sql).not.toContain("BEGIN READ ONLY");
    expect(fake.releases).toBe(1);
    expect(fake.closes).toBe(1);
  });
  it("does not reuse writer credential gate or weaken URL validation", async () => {
    process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "false";
    await expect(resolveMarketplaceFinanceDevDatabaseUrl()).rejects.toThrow("DEV_FINANCE_DISABLED");
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV =
      FINANCE_URL.replace("sslmode=verify-full","sslmode=disable");
    await expect(readMarketplaceFinanceSummaryDev(1)).rejects.toThrow();
  });
});
