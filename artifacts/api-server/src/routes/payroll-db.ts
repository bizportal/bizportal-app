import pg from "pg";
import { pool } from "@workspace/db";

const { Pool } = pg;
let dedicatedPool: pg.Pool | null = null;
let initializedUrl: string | null = null;

/**
 * Separate, least-privilege DEV login for Payroll. Never replace BizPortal's
 * shared connection or allow a DEV Payroll credential in production.
 */
function dedicatedPayrollUrl(): string | null {
  if (process.env.APP_ENV !== "development") return null;
  const raw = process.env.PAYROLL_DATABASE_URL_DEV?.trim();
  if (!raw) return null;
  const parsed = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Invalid payroll DB scheme");
  const username = decodeURIComponent(parsed.username);
  const ref = "xssrfshdrtdfupgqwfdw";
  if (!(username === "bizportal_payroll_dev" || username === `bizportal_payroll_dev.${ref}`) ||
      !(`${parsed.hostname} ${username}`.includes(ref)) ||
      `${parsed.hostname} ${username}`.includes("nzdweipzckfszczzqtuw")) {
    throw new Error("Payroll connection must use the dedicated CST-DEV database role");
  }
  return raw;
}

export function payrollDedicatedEnabled(): boolean {
  return dedicatedPayrollUrl() !== null;
}

export function getPayrollPool(): pg.Pool {
  const url = dedicatedPayrollUrl();
  if (!url) return pool;
  if (dedicatedPool && initializedUrl === url) return dedicatedPool;
  if (dedicatedPool) throw new Error("Payroll database credentials changed; restart the process");
  dedicatedPool = new Pool({
    connectionString: url,
    application_name: "bizportal-payroll-dev",
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 8_000,
    query_timeout: 15_000,
  });
  initializedUrl = url;
  return dedicatedPool;
}

/** The company scope exists only for the active SQL transaction (not the pool). */
export async function setPayrollCompanyScope(client: pg.PoolClient, companyId: number): Promise<void> {
  if (!payrollDedicatedEnabled()) return;
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Invalid payroll company scope");
  await client.query("SELECT set_config('app.payroll_company_id', $1, true)", [String(companyId)]);
}

export async function payrollScopedQuery(
  companyId: number,
  sql: string,
  values: unknown[],
): Promise<pg.QueryResult> {
  if (!payrollDedicatedEnabled()) return pool.query(sql, values);
  const client = await getPayrollPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await setPayrollCompanyScope(client, companyId);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* original error wins */ }
    throw error;
  } finally {
    client.release();
  }
}
