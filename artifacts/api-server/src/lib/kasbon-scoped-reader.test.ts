import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withScopedKasbonReadOnly, type KasbonScopedClient } from "./kasbon-scoped-reader";

type Step = { sql: string; values?: unknown[] };
function fake(options: { role?: string; company?: string; readOnly?: string; failOn?: string } = {}) {
  const statements: Step[] = [];
  const release = vi.fn();
  const client: KasbonScopedClient = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (options.failOn && sql.includes(options.failOn)) throw Error("DB_FAILURE");
      if (sql.includes("current_user AS role")) {
        return { rowCount: 1, rows: [{
          role: options.role ?? "bizportal_payroll_prod",
          company: options.company ?? "1",
          read_only: options.readOnly ?? "on",
        }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release,
  };
  return { client, statements, release };
}

describe("isolated Kasbon read-only role and company boundary", () => {
  beforeEach(() => vi.stubEnv("APP_ENV", "production"));
  afterEach(() => vi.unstubAllEnvs());

  it("begins read-only, assumes least-privilege role and validates scoped identity before SELECT", async () => {
    const f = fake();
    const value = await withScopedKasbonReadOnly(f.client, 1, async c => {
      await c.query("SELECT id FROM public.cash_advances WHERE company_id = $1", [1]);
      return "ok";
    });
    expect(value).toBe("ok");
    expect(f.statements.map(s => s.sql)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL ROLE bizportal_payroll_prod",
      "SELECT set_config('app.payroll_company_id', $1, true)",
      "SELECT current_user AS role, current_setting('app.payroll_company_id',true) AS company, current_setting('transaction_read_only') AS read_only",
      "SELECT id FROM public.cash_advances WHERE company_id = $1",
      "COMMIT",
    ]);
    expect(f.statements[2].values).toEqual(["1"]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid tenant %s without SQL and releases connection", async company => {
      const f = fake();
      const read = vi.fn();
      await expect(withScopedKasbonReadOnly(f.client, company, read))
        .rejects.toThrow("KASBON_COMPANY_SCOPE_INVALID");
      expect(f.statements).toHaveLength(0);
      expect(read).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it("rejects DEV before SQL", async () => {
    vi.stubEnv("APP_ENV", "development");
    const f = fake();
    await expect(withScopedKasbonReadOnly(f.client, 1, async () => "unexpected"))
      .rejects.toThrow("KASBON_READER_PROD_ONLY");
    expect(f.statements).toHaveLength(0);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([
    { role: "postgres" }, { role: "bizportal_hrd_prod" },
    { company: "2" }, { company: "" }, { readOnly: "off" },
  ])("rolls back and rejects wrong role, tenant or transaction mode %#", async options => {
    const f = fake(options);
    const read = vi.fn();
    await expect(withScopedKasbonReadOnly(f.client, 1, read))
      .rejects.toThrow("KASBON_READER_IDENTITY_SCOPE_INVALID");
    expect(read).not.toHaveBeenCalled();
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("rolls back on SELECT failure, never commits or leaks connection", async () => {
    const f = fake({ failOn: "FROM public.cash_advances" });
    await expect(withScopedKasbonReadOnly(f.client, 1, c =>
      c.query("SELECT id FROM public.cash_advances WHERE company_id=$1", [1]),
    )).rejects.toThrow("DB_FAILURE");
    expect(f.statements.map(x=>x.sql)).not.toContain("COMMIT");
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([
    "set_config('app.payroll_company_id'",
    "current_user AS role",
    "COMMIT",
  ])("rolls back and releases client when %s fails", async step => {
    const f = fake({ failOn: step });
    const read = vi.fn(async () => "safe");
    await expect(withScopedKasbonReadOnly(f.client, 1, read)).rejects.toThrow("DB_FAILURE");
    if (step !== "COMMIT") expect(read).not.toHaveBeenCalled();
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("releases the client when starting READ ONLY fails", async () => {
    const f = fake({ failOn: "BEGIN READ ONLY" });
    const read = vi.fn();
    await expect(withScopedKasbonReadOnly(f.client, 1, read)).rejects.toThrow("DB_FAILURE");
    expect(read).not.toHaveBeenCalled();
    expect(f.statements.map(x => x.sql)).toEqual(["BEGIN READ ONLY"]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("fails closed when role switch itself fails", async () => {
    const f = fake({failOn:"SET LOCAL ROLE"});
    await expect(withScopedKasbonReadOnly(f.client, 1, async ()=>null)).rejects.toThrow("DB_FAILURE");
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });
});
