import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

/**
 * Real PostgreSQL / real Advance HTTP route / real RLS on disposable localhost.
 * Session boundary intentionally mocked. This is NOT signed-session E2E.
 * Never execute this test against CST DEV or PROD.
 */
const enabled = Boolean(process.env.KASBON_DISPOSABLE_PG_URL);
const disposablePool = vi.hoisted(() => ({ value: null as null | typeof import("@workspace/db")["pool"] }));
const state = vi.hoisted(() => ({
  session: true, actor: true, role: "finance", companyId: 900001,
}));
vi.mock("./dev-auth", () => ({
  getProductionSession: () => state.session ? { id: "synthetic-session" } : null,
  getProductionUser: async () => state.actor ? {
    id: "synthetic-actor", email: "finance@example.test", role: state.role,
    companyId: state.companyId, firstName: null, lastName: null,
  } : null,
}));

vi.mock("./payroll-prod-db", () => ({
  payrollReadOnlyReady: () => true,
  payrollScopedQuery: async (companyId: number, sql: string, values: unknown[]) => {
    const pool = disposablePool.value;
    if (!pool) throw Error("CI_DISPOSABLE_POOL_NOT_INITIALIZED");
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL ROLE ci_kasbon_reader");
      await client.query("SELECT set_config('app.payroll_company_id', $1, true)", [String(companyId)]);
      const identity = await client.query(
        "SELECT current_user AS role, current_setting('transaction_read_only') AS mode, current_setting('app.payroll_company_id',true) AS company",
      );
      if (identity.rows[0]?.role !== "ci_kasbon_reader" ||
          identity.rows[0]?.mode !== "on" ||
          identity.rows[0]?.company !== String(companyId)) throw Error("CI_KASBON_SCOPE_INVALID");
      const result = await client.query(sql, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
}));

describe.skipIf(!enabled)("Kasbon HTTP with REAL disposable PostgreSQL and scoped RLS", () => {
  let server: Server;
  let base: string;
  let pool: typeof import("@workspace/db")["pool"];
  const companyOne = 900001, companyTwo = 900002;

  beforeAll(async () => {
    const raw = process.env.KASBON_DISPOSABLE_PG_URL;
    if (!raw) throw Error("Missing disposable Postgres URL");
    const url = new URL(raw);
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
        url.port !== "65432" || url.pathname !== "/kasbon_ci" ||
        url.username !== "postgres") {
      throw Error("KASBON_CI_REJECTS_NON_DISPOSABLE_DB");
    }
    process.env.APP_ENV = "production"; // Only to exercise GET-only PROD gate, never an actual PROD connection.
    const { createDedicatedPayrollPool } = await import("@workspace/db");
    pool = createDedicatedPayrollPool(raw);
    disposablePool.value = pool;

    await pool.query(`CREATE TABLE public.employees (
      id integer PRIMARY KEY, company_id integer NOT NULL,
      first_name text, last_name text
    )`);
    await pool.query(`CREATE TABLE public.cash_advances (
      id integer PRIMARY KEY, company_id integer NOT NULL, employee_id integer,
      advance_number text, date date, type text, amount numeric,
      remaining_amount numeric, settled_amount numeric, paid_amount numeric,
      status text, lifecycle_status text, posting_status text,
      approved_at timestamptz, approved_by text, disbursed_at timestamptz,
      disbursed_by text, accounting_entry_id integer, voided_at timestamptz
    )`);
    await pool.query("INSERT INTO public.employees VALUES (1,900001,'Synthetic','One'), (2,900002,'Synthetic','Two')");
    await pool.query(`INSERT INTO public.cash_advances
      (id,company_id,employee_id,advance_number,date,type,amount,remaining_amount,settled_amount,paid_amount,status,lifecycle_status,posting_status)
      VALUES
      (101,900001,1,'CI-KSB-001','2099-10-01','kasbon',1200,1200,0,0,'DRAFT','outstanding','PENDING'),
      (202,900002,2,'CI-KSB-002','2099-10-02','kasbon',2300,2300,0,0,'DRAFT','outstanding','PENDING')`);
    await pool.query("CREATE ROLE ci_kasbon_reader NOLOGIN NOBYPASSRLS");
    await pool.query("GRANT USAGE ON SCHEMA public TO ci_kasbon_reader");
    await pool.query("GRANT SELECT ON public.employees, public.cash_advances TO ci_kasbon_reader");
    await pool.query("ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY");
    await pool.query("ALTER TABLE public.cash_advances ENABLE ROW LEVEL SECURITY");
    await pool.query(`CREATE POLICY ci_employees_scope ON public.employees FOR SELECT TO ci_kasbon_reader
      USING (company_id = NULLIF(current_setting('app.payroll_company_id',true),'')::integer)`);
    await pool.query(`CREATE POLICY ci_advances_scope ON public.cash_advances FOR SELECT TO ci_kasbon_reader
      USING (company_id = NULLIF(current_setting('app.payroll_company_id',true),'')::integer AND type='kasbon')`);

    const { default: router } = await import("./advance-kasbon-readonly");
    const app = express();
    app.use((req, _res, next) => {
      req.log = { error: vi.fn() } as unknown as typeof req.log;
      next();
    });
    app.use(express.json());
    app.use("/api", router);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("NO_ISOLATED_LISTENER");
    base = "http://127.0.0.1:" + address.port;
  });
  beforeEach(() => {
    state.session = true; state.actor = true; state.role = "finance"; state.companyId = companyOne;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (pool) await pool.end(); // Disposable CI container is destroyed after job.
    disposablePool.value = null;
  });
  const get = (route: string) => fetch(base + route);

  it("returns only company-1 Kasbon records through actual SQL and RLS", async () => {
    const response = await get("/api/advances?companyId=900001");
    expect(response.status).toBe(200);
    const body = await response.json() as {total:number;data:Array<{advance_number:string;requires_source_review:boolean}>;readOnly:boolean};
    expect(body.total).toBe(1);
    expect(body.data.map(x=>x.advance_number)).toEqual(["CI-KSB-001"]);
    expect(body.data[0].requires_source_review).toBe(true);
    expect(body.readOnly).toBe(true);
  });
  it("rejects cross-company request for finance actor before SQL", async () => {
    expect((await get("/api/advances?companyId=900002")).status).toBe(403);
  });
  it("returns only company-2 data after switching synthetic actor", async () => {
    state.companyId = companyTwo;
    const response = await get("/api/advances?companyId=900002");
    expect(response.status).toBe(200);
    const body = await response.json() as {total:number;data:Array<{advance_number:string}>};
    expect(body.total).toBe(1);
    expect(body.data.map(x=>x.advance_number)).toEqual(["CI-KSB-002"]);
  });
  it("blocks missing session, revoked actor and unsupported role", async () => {
    state.session = false;
    expect((await get("/api/advances?companyId=900001")).status).toBe(401);
    state.session = true; state.actor = false;
    expect((await get("/api/advances?companyId=900001")).status).toBe(403);
    state.actor = true; state.role = "staff";
    expect((await get("/api/advances?companyId=900001")).status).toBe(403);
  });
  it("blocks reading other tenant even when query SQL asks for it under company-one RLS", async () => {
    const { payrollScopedQuery } = await import("./payroll-prod-db");
    const result = await payrollScopedQuery(companyOne,
      "SELECT count(*)::integer AS n FROM public.cash_advances WHERE company_id=$1", [companyTwo]);
    expect(result.rows[0]?.n).toBe(0);
  });
  it("proves CI role cannot perform financial writes inside read-only transaction", async () => {
    const { payrollScopedQuery } = await import("./payroll-prod-db");
    await expect(payrollScopedQuery(companyOne,
      "UPDATE public.cash_advances SET amount=0 WHERE company_id=$1", [companyOne]))
      .rejects.toThrow();
    const check = await pool.query("SELECT amount::integer AS amount FROM public.cash_advances WHERE id=101");
    expect(check.rows[0]?.amount).toBe(1200);
  });
  it("does not expose a POST writer endpoint", async () => {
    const response = await fetch(base + "/api/advances?companyId=900001", {
      method: "POST", headers: {"Content-Type":"application/json"}, body: "{}",
    });
    expect([404,405]).toContain(response.status);
  });
});
