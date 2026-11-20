import pg from "pg";
import { X509Certificate } from "node:crypto";
import { readSecret } from "./gcp-database-secret";
import {
  SUPABASE_FINANCE_ROOT_2021_PEM,
  SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256,
} from "./supabase-finance-root-2021";

const EXPECTED_PROJECT = "xssrfshdrtdfupgqwfdw";
const EXPECTED_ROLE = "bizportal_fleet_finance_login_dev";
const EXPECTED_SECRET = "bizportal-fleet-finance-dev";
const SOURCE_COMPANY = 1;
const FINANCE_COMPANY = 3;

export type FleetFinanceDevScope = { sourceCompanyId: number; companyId: number };
type SecretReader = typeof readSecret;
let cachedSecret: { value: string; expiresAt: number } | null = null;
let pendingSecret: Promise<string> | null = null;
let financePool: pg.Pool | null = null;
let activeDatabaseUrl: string | null = null;

function requireDevelopment(): void {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      process.env.FLEET_FINANCE_DATABASE_ENABLED_DEV !== "true") {
    throw new Error("FLEET_FINANCE_DEV_DATABASE_DISABLED");
  }
}

function securePoolOptions(raw: string): pg.PoolConfig {
  let url: URL;
  let user: string;
  let password: string;
  let database: string;
  try {
    url = new URL(raw);
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("FLEET_FINANCE_DEV_DATABASE_URL_INVALID");
  }
  const host = url.hostname.toLowerCase();
  const direct = host === `db.${EXPECTED_PROJECT}.supabase.co`;
  const pooler = host.endsWith(".pooler.supabase.com");
  const port = Number(url.port || 5432);
  if (!["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")) {
    throw new Error("FLEET_FINANCE_DEV_DATABASE_SSL_REQUIRED");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !password || database !== "postgres" ||
      !Number.isSafeInteger(port) || ![5432, 6543].includes(port) ||
      !((direct && user === EXPECTED_ROLE) || (pooler && user === `${EXPECTED_ROLE}.${EXPECTED_PROJECT}`)) ||
      raw.includes("nzdweipzckfszczzqtuw")) {
    throw new Error("FLEET_FINANCE_DEV_DATABASE_IDENTITY_INVALID");
  }
  const certificate = new X509Certificate(SUPABASE_FINANCE_ROOT_2021_PEM);
  if (!certificate.ca || certificate.fingerprint256.toUpperCase() !== SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256) {
    throw new Error("FLEET_FINANCE_DEV_PINNED_CA_INVALID");
  }
  // Explicit fields prevent URL sslrootcert/ssl options from overriding strict TLS.
  return {
    host, port, user, password, database,
    ssl: { rejectUnauthorized: true, servername: host, ca: SUPABASE_FINANCE_ROOT_2021_PEM },
    max: 2, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 5_000,
    query_timeout: 20_000, application_name: "bizportal-fleet-finance-dev",
  };
}

/** The Fleet credential is never resolved through the general or Diva reader pool. */
export async function resolveFleetFinanceDevDatabaseUrl(secretReader: SecretReader = readSecret): Promise<string> {
  requireDevelopment();
  const direct = process.env.FLEET_FINANCE_DATABASE_URL_DEV?.trim();
  const secretName = process.env.FLEET_FINANCE_GCP_SECRET_NAME_DEV?.trim();
  if (direct && secretName) throw new Error("FLEET_FINANCE_DEV_CREDENTIAL_SOURCE_AMBIGUOUS");
  if (direct) {
    securePoolOptions(direct);
    return direct;
  }
  if (secretName !== EXPECTED_SECRET) {
    throw new Error("FLEET_FINANCE_DEV_SECRET_NOT_CONFIGURED");
  }
  let raw: string;
  if (cachedSecret && cachedSecret.expiresAt > Date.now()) {
    raw = cachedSecret.value;
  } else {
    if (!pendingSecret) {
      pendingSecret = secretReader(EXPECTED_SECRET, { signal: AbortSignal.timeout(8_000) })
        .then((value) => {
          const candidate = value.trim();
          securePoolOptions(candidate);
          cachedSecret = { value: candidate, expiresAt: Date.now() + 60_000 };
          return candidate;
        }).finally(() => { pendingSecret = null; });
    }
    raw = await pendingSecret;
  }
  securePoolOptions(raw);
  return raw;
}

async function getFinancePool(): Promise<pg.Pool> {
  const raw = await resolveFleetFinanceDevDatabaseUrl();
  if (financePool && activeDatabaseUrl !== raw) {
    throw new Error("FLEET_FINANCE_DEV_CREDENTIAL_CHANGED_RESTART_REQUIRED");
  }
  if (!financePool) {
    financePool = new pg.Pool(securePoolOptions(raw));
    // An idle connection error must not terminate the API or reveal its DSN.
    financePool.on("error", () => undefined);
    activeDatabaseUrl = raw;
  }
  return financePool;
}

/** This is an ACL preflight for cash posting/reversal, not a committed posting test. */
export async function getFleetFinanceDevWriteReadiness(client: pg.PoolClient) {
  const writeEnabled = process.env.FLEET_FINANCE_WRITE_ENABLED === "true";
  if (!writeEnabled) return { writeEnabled: false, writeReady: false, settingsReadOnly: true };
  const result = await client.query(
    `SELECT
       has_table_privilege(current_user,'public.fleet_cash_payments','SELECT')
       AND has_column_privilege(current_user,'public.fleet_cash_payments','id','UPDATE')
       AND has_table_privilege(current_user,'public.accounting_entries','SELECT')
       AND has_table_privilege(current_user,'public.accounting_entry_lines','SELECT')
       AND has_table_privilege(current_user,'public.fleet_ledger_entries','SELECT')
       AND has_table_privilege(current_user,'public.financial_periods','SELECT')
       AND (SELECT bool_and(has_column_privilege(current_user,'public.accounting_entries',col,'INSERT'))
              FROM unnest(ARRAY['entry_number','journal_id','date','ref','description','status','source','source_id',
                   'total_debit','total_credit','created_by_id','company_id','source_module','source_schema',
                   'source_table','entry_status','source_event_id','previous_entry_id']) AS col)
       AND (SELECT bool_and(has_column_privilege(current_user,'public.accounting_entries',col,'UPDATE'))
              FROM unnest(ARRAY['status','entry_status','posted_at']) AS col)
       AND (SELECT bool_and(has_column_privilege(current_user,'public.accounting_entry_lines',col,'INSERT'))
              FROM unnest(ARRAY['entry_id','account_id','description','debit','credit','company_id',
                   'source_module','source_table','source_id']) AS col)
       AND (SELECT bool_and(has_column_privilege(current_user,'public.fleet_ledger_entries',col,'INSERT'))
              FROM unnest(ARRAY['company_id','ledger_date','period','source_type','source_id','source_ref','account_id',
                   'account_code','account_name','account_type','debit','credit','description','created_by']) AS col)
       AND has_sequence_privilege(current_user,pg_get_serial_sequence('public.accounting_entries','id'),'USAGE')
       AND has_sequence_privilege(current_user,pg_get_serial_sequence('public.accounting_entry_lines','id'),'USAGE')
       AND has_sequence_privilege(current_user,pg_get_serial_sequence('public.fleet_ledger_entries','id'),'USAGE')
       AS privileges_ready`,
  );
  return { writeEnabled, writeReady: result.rows[0]?.privileges_ready === true, settingsReadOnly: true };
}

/** Scope and role are fixed by this DEV integration, never by a request GUC alone. */
export async function withFleetFinanceDevTransaction<T>(
  scope: FleetFinanceDevScope,
  work: (client: pg.PoolClient) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  requireDevelopment();
  if (scope.sourceCompanyId !== SOURCE_COMPANY || scope.companyId !== FINANCE_COMPANY) {
    throw new Error("FLEET_FINANCE_DEV_COMPANY_SCOPE_INVALID");
  }
  if (options.readOnly !== true && process.env.FLEET_FINANCE_WRITE_ENABLED !== "true") {
    throw new Error("FLEET_FINANCE_DEV_WRITES_DISABLED");
  }
  const client = await (await getFinancePool()).connect();
  let discard = false;
  try {
    await client.query(options.readOnly === true ? "BEGIN READ ONLY" : "BEGIN");
    const identity = await client.query(
      `SELECT current_user::text AS db_role,session_user::text AS login_role,current_database() AS database_name,
              COALESCE((SELECT rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb
                          FROM pg_catalog.pg_roles WHERE rolname=current_user),true) AS unsafe_role,
              row_security_active('public.companies'::regclass) AS companies_rls,
              row_security_active('public.fleet_cash_payments'::regclass) AS source_rls,
              row_security_active('public.accounting_settings'::regclass) AS settings_rls,
              row_security_active('public.chart_of_accounts'::regclass) AS accounts_rls,
              row_security_active('public.accounting_journals'::regclass) AS journals_rls,
              row_security_active('public.accounting_entries'::regclass) AS entries_rls,
              row_security_active('public.accounting_entry_lines'::regclass) AS lines_rls,
              row_security_active('public.fleet_ledger_entries'::regclass) AS ledger_rls,
              row_security_active('public.financial_periods'::regclass) AS periods_rls`,
    );
    const row = identity.rows[0];
    if (row?.db_role !== EXPECTED_ROLE || row?.login_role !== EXPECTED_ROLE || row?.database_name !== "postgres" ||
        row?.unsafe_role !== false ||
        ["companies_rls", "source_rls", "settings_rls", "accounts_rls", "journals_rls", "entries_rls", "lines_rls", "ledger_rls", "periods_rls"]
          .some((key) => row?.[key] !== true)) {
      throw new Error("FLEET_FINANCE_DEV_ROLE_OR_RLS_UNVERIFIED");
    }
    const binding = await client.query(
      `SELECT set_config('app.fleet_source_company_id',$1,true) AS source_company_id,
              set_config('app.fleet_finance_company_id',$2,true) AS finance_company_id,
              set_config('statement_timeout','15000',true),set_config('lock_timeout','8000',true)`,
      [String(SOURCE_COMPANY), String(FINANCE_COMPANY)],
    );
    if (binding.rows[0]?.source_company_id !== String(SOURCE_COMPANY) ||
        binding.rows[0]?.finance_company_id !== String(FINANCE_COMPANY)) {
      throw new Error("FLEET_FINANCE_DEV_TENANT_BINDING_FAILED");
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function closeFleetFinanceDevPool(): Promise<void> {
  const existing = financePool;
  financePool = null;
  activeDatabaseUrl = null;
  cachedSecret = null;
  if (existing) await existing.end();
}
