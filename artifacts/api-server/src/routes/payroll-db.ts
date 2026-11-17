import { pool, createDedicatedPayrollPool, type PayrollDbClient, type PayrollDbQueryResult } from "@workspace/db";

type PayrollPool = typeof pool;
let dedicatedPool: PayrollPool | null = null;
let initializedUrl: string | null = null;

/**
 * Separate, least-privilege DEV login for Payroll. Never replace BizPortal's
 * shared connection or allow a DEV Payroll credential in production.
 */
const PAYROLL_DEV_REF = "xssrfshdrtdfupgqwfdw";
const PAYROLL_DEV_LOGIN = "bizportal_payroll_dev";

/** The localhost exception is confined to the already-existing disposable CI
 * database and cannot be selected by any normal DEV or PROD runtime.
 */
function isDisposablePayrollTestUrl(url: URL, username: string): boolean {
  if (process.env.APP_ENV !== "development" ||
      process.env.NODE_ENV !== "test" ||
      !process.env.PAYROLL_PG_E2E_URL) return false;
  let fixture: URL;
  try { fixture = new URL(process.env.PAYROLL_PG_E2E_URL); }
  catch { return false; }
  return fixture.protocol === "postgresql:" &&
    fixture.hostname === "127.0.0.1" &&
    fixture.port === "65432" &&
    fixture.pathname === "/payroll_ci" &&
    fixture.username === "postgres." + PAYROLL_DEV_REF &&
    url.hostname === "127.0.0.1" &&
    url.port === "65432" &&
    url.pathname === "/payroll_ci" &&
    url.search === "" &&
    username === PAYROLL_DEV_LOGIN + "." + PAYROLL_DEV_REF;
}

/** Project- and role-pinned dedicated Payroll connection.
 * Refuse arbitrary domains, ambiguous URL parameters and unverified TLS.
 */
function dedicatedPayrollUrl(): string | null {
  if (process.env.APP_ENV !== "development") return null;
  const raw = process.env.PAYROLL_DATABASE_URL_DEV?.trim();
  if (!raw) return null;
  let url: URL;
  let username: string;
  try {
    url = new URL(raw);
    username = decodeURIComponent(url.username);
  } catch {
    throw Error("PAYROLL_DEV_DATABASE_URL_REJECTED");
  }

  const host = url.hostname.toLowerCase();
  const direct = host === "db." + PAYROLL_DEV_REF + ".supabase.co" &&
    username === PAYROLL_DEV_LOGIN && (url.port || "5432") === "5432";
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\\.pooler\\.supabase\\.com$/.test(host) &&
    username === PAYROLL_DEV_LOGIN + "." + PAYROLL_DEV_REF &&
    ["5432", "6543"].includes(url.port || "5432");

  const queryKeys = [...url.searchParams.keys()];
  const verifiedTls = queryKeys.every(key =>
    key === "sslmode" || key === "sslrootcert") &&
    url.searchParams.getAll("sslmode").length === 1 &&
    url.searchParams.get("sslmode") === "verify-full" &&
    url.searchParams.getAll("sslrootcert").length <= 1;

  const allowedSupabaseUrl = (direct || pooler) && verifiedTls &&
    url.pathname === "/postgres";

  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.password ||
      !(allowedSupabaseUrl || isDisposablePayrollTestUrl(url, username))) {
    // Fail closed without reflecting a credential or destination into logs.
    throw Error("PAYROLL_DEV_DATABASE_URL_REJECTED");
  }
  return raw;
}

export function payrollDedicatedEnabled(): boolean {
  return dedicatedPayrollUrl() !== null;
}

export function getPayrollPool(): PayrollPool {
  const url = dedicatedPayrollUrl();
  if (!url) return pool;
  if (dedicatedPool && initializedUrl === url) return dedicatedPool;
  if (dedicatedPool) throw new Error("Payroll database credentials changed; restart the process");
  dedicatedPool = createDedicatedPayrollPool(url);
  initializedUrl = url;
  return dedicatedPool;
}

/** The company scope exists only for the active SQL transaction (not the pool). */
export async function setPayrollCompanyScope(client: PayrollDbClient, companyId: number): Promise<void> {
  if (!payrollDedicatedEnabled()) return;
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Invalid payroll company scope");
  await client.query("SELECT set_config('app.payroll_company_id', $1, true)", [String(companyId)]);
}

export async function payrollScopedQuery(
  companyId: number,
  sql: string,
  values: unknown[],
): Promise<PayrollDbQueryResult> {
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

/** Explicit pool shutdown for isolated test teardown / controlled maintenance. */
export async function closeDedicatedPayrollPool(): Promise<void> {
  const previous = dedicatedPool;
  dedicatedPool = null;
  initializedUrl = null;
  if (previous) await previous.end();
}
