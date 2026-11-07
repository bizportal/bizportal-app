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

  it("disables ALL Draft writes after flag is OFF", async () => {
    delete process.env.PAYROLL_DEV_DRAFT_ENABLED;
    const blocked = await post(companyOne, 11, 2099);
    expect(blocked.status).toBe(501);
    const result = await pool.query("SELECT COUNT(*)::integer AS count FROM public.payroll_runs WHERE company_id=$1 AND month=11", [companyOne]);
    expect(result.rows[0].count).toBe(0);
  });
});
