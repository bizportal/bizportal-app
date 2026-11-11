import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

/**
 * REAL PostgreSQL + HTTP Draft verification.
 * This file is intentionally excluded from the default test runner unless
 * PAYROLL_PG_E2E_URL is set by the dedicated disposable CI service.
 */
const enabled = Boolean(process.env.PAYROLL_PG_E2E_URL);
const actor = vi.hoisted(() => ({
  role: "admin",
  companyId: null as number | null,
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  getDevSession: () => ({
    id: "ci-admin", email: "ci@example.test", role: actor.role,
    companyId: actor.companyId, firstName: null, lastName: null,
  }),
  getProductionSession: () => null,
  getProductionUser: async () => null,
}));

describe.skipIf(!enabled)("Payroll Draft REAL PostgreSQL HTTP isolated CI", () => {
  let server: Server;
  let base: string;
  let pool: typeof import("@workspace/db")["pool"];
  const companyOne = 900001;
  const companyTwo = 900002;

  async function post(companyId: number, month: number, year: number) {
    const response = await fetch(`${base}/api/payroll/runs?companyId=${companyId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month, year, notes: "DISPOSABLE_CI_ONLY" }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    if (!process.env.PAYROLL_PG_E2E_URL) throw new Error("Missing CI Postgres URL");
    // Explicitly prevent this test from running against the real DEV/PROD projects.
    const url = new URL(process.env.PAYROLL_PG_E2E_URL);
    if (url.hostname !== "127.0.0.1" || url.port !== "65432" ||
      url.pathname !== "/payroll_ci" || url.username !== "postgres.xssrfshdrtdfupgqwfdw") {
      throw new Error("Refusing Payroll E2E outside disposable localhost PostgreSQL");
    }
    process.env.APP_ENV = "development";
    process.env.SUPABASE_DATABASE_URL_DEV = process.env.PAYROLL_PG_E2E_URL;
    process.env.PAYROLL_DEV_DRAFT_ENABLED = "true";
    ({ pool } = await import("@workspace/db"));
    await pool.query(`CREATE TABLE IF NOT EXISTS public.payroll_runs (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id integer NOT NULL,
      month integer NOT NULL,
      year integer NOT NULL,
      notes text,
      status text NOT NULL DEFAULT 'draft',
      posting_status text NOT NULL DEFAULT 'pending',
      accounting_entry_id integer,
      payment_entry_id integer
    )`);
    await pool.query("TRUNCATE TABLE public.payroll_runs RESTART IDENTITY");
    const { default: router } = await import("./payroll");
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
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No isolated HTTP listener");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    delete process.env.PAYROLL_DEV_DRAFT_ENABLED;
    if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    if (pool) {
      await pool.query("DROP TABLE IF EXISTS public.payroll_runs");
      await pool.end();
    }
  });

  it("persists a Draft via HTTP and reads it from REAL PostgreSQL without financial postings", async () => {
    const response = await post(companyOne, 12, 2099);
    expect(response.status).toBe(201);
    expect((response.body.run as { companyId: number; status: string }).companyId).toBe(companyOne);
    expect((response.body.run as { status: string }).status).toBe("draft");
    const result = await pool.query("SELECT company_id, month, year, status, posting_status, accounting_entry_id, payment_entry_id FROM public.payroll_runs WHERE company_id=$1", [companyOne]);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      company_id: companyOne, month: 12, year: 2099, status: "draft",
      posting_status: "pending", accounting_entry_id: null, payment_entry_id: null,
    });
  });

  it("rejects duplicate Draft in same company and retains exactly one row", async () => {
    const second = await post(companyOne, 12, 2099);
    expect(second.status).toBe(409);
    const result = await pool.query("SELECT COUNT(*)::integer AS count FROM public.payroll_runs WHERE company_id=$1 AND month=12 AND year=2099", [companyOne]);
    expect(result.rows[0].count).toBe(1);
  });

  it("accepts the same period under a different company without mixing records", async () => {
    const response = await post(companyTwo, 12, 2099);
    expect(response.status).toBe(201);
    const result = await pool.query("SELECT company_id, COUNT(*)::integer AS count FROM public.payroll_runs GROUP BY company_id ORDER BY company_id");
    expect(result.rows).toEqual([{ company_id: companyOne, count: 1 }, { company_id: companyTwo, count: 1 }]);
  });

  it("stops a company-bound admin from inserting into another company", async () => {
    actor.companyId = companyOne;
    const blocked = await post(companyTwo, 11, 2099);
    expect(blocked.status).toBe(403);
    const result = await pool.query("SELECT COUNT(*)::integer AS count FROM public.payroll_runs WHERE company_id=$1 AND month=11", [companyTwo]);
    expect(result.rows[0].count).toBe(0);
  });

  it("serializes eight simultaneous HTTP requests into exactly one Draft", async () => {
    // Separate period from earlier tests to prove real concurrent advisory locking.
    actor.companyId = null;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => post(companyOne, 10, 2099)),
    );
    const statuses = attempts.map((attempt) => attempt.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const persisted = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM public.payroll_runs WHERE company_id=$1 AND month=$2 AND year=$3",
      [companyOne, 10, 2099],
    );
    expect(persisted.rows[0].count).toBe(1);
    const one = attempts.find((attempt) => attempt.status === 201);
    expect((one?.body.run as { status: string }).status).toBe("draft");
  });

  it("uses a distinct RLS-restricted login for HTTP Draft and denies unscoped reads", async () => {
    const username = "bizportal_payroll_dev.xssrfshdrtdfupgqwfdw";
    const ciPassword = "ci_only_disposable";
    const roleSql = '"' + username + '"';
    await pool.query(`CREATE ROLE ${roleSql} LOGIN PASSWORD '${ciPassword}'`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${roleSql}`);
    await pool.query(`GRANT SELECT ON public.payroll_runs TO ${roleSql}`);
    await pool.query(`GRANT INSERT (company_id,month,year,notes,status) ON public.payroll_runs TO ${roleSql}`);
    await pool.query(`ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY`);
    await pool.query(`CREATE POLICY ci_payroll_read ON public.payroll_runs FOR SELECT TO ${roleSql}
      USING (company_id = NULLIF(current_setting('app.payroll_company_id', true), '')::integer)`);
    await pool.query(`CREATE POLICY ci_payroll_write ON public.payroll_runs FOR INSERT TO ${roleSql}
      WITH CHECK (company_id = NULLIF(current_setting('app.payroll_company_id', true), '')::integer
        AND status = 'draft' AND posting_status = 'pending'
        AND accounting_entry_id IS NULL AND payment_entry_id IS NULL)`);

    const dedicatedUrl = `postgresql://${username}:${ciPassword}@127.0.0.1:65432/payroll_ci`;
    process.env.PAYROLL_DATABASE_URL_DEV = dedicatedUrl;
    process.env.PAYROLL_DEV_DRAFT_ENABLED = "true";
    actor.companyId = null;
    try {
      const response = await post(companyOne, 9, 2099);
      expect(response.status).toBe(201);
      expect((response.body.run as { companyId: number }).companyId).toBe(companyOne);
      const row = await pool.query("SELECT company_id, status, posting_status, payment_entry_id FROM public.payroll_runs WHERE company_id=$1 AND month=9", [companyOne]);
      expect(row.rows[0]).toMatchObject({ company_id: companyOne, status: "draft", posting_status: "pending", payment_entry_id: null });

      const { createDedicatedPayrollPool } = await import("@workspace/db");
      const unscopedPool = createDedicatedPayrollPool(dedicatedUrl);
      try {
        const unscoped = await unscopedPool.query("SELECT COUNT(*)::integer AS count FROM public.payroll_runs");
        expect(unscoped.rows[0].count).toBe(0);
        const updatePermission = await unscopedPool.query("SELECT has_table_privilege(current_user,'public.payroll_runs','UPDATE') AS allowed");
        expect(updatePermission.rows[0].allowed).toBe(false);
      } finally {
        await unscopedPool.end();
      }
    } finally {
      delete process.env.PAYROLL_DATABASE_URL_DEV;
      const { closeDedicatedPayrollPool } = await import("./payroll-db");
      await closeDedicatedPayrollPool();
    }
  });

  it("disables ALL Draft writes after flag is OFF", async () => {
    delete process.env.PAYROLL_DEV_DRAFT_ENABLED;
    const blocked = await post(companyOne, 11, 2099);
    expect(blocked.status).toBe(501);
    const result = await pool.query("SELECT COUNT(*)::integer AS count FROM public.payroll_runs WHERE company_id=$1 AND month=11", [companyOne]);
    expect(result.rows[0].count).toBe(0);
  });
});
