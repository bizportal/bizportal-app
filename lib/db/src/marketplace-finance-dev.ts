import pg from "pg";
import { X509Certificate } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { readSecret } from "./gcp-database-secret";
import {
  SUPABASE_FINANCE_ROOT_2021_PEM,
  SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256,
} from "./supabase-finance-root-2021";

type ScopedDb = typeof import("./index").db;
type FinanceDatabase = ReturnType<typeof drizzle<typeof schema>>;

const EXPECTED_PROJECT = "xssrfshdrtdfupgqwfdw";
const EXPECTED_ROLE = "bizportal_marketplace_finance_login_dev";
let financePool: pg.Pool | null = null;
let financeDb: FinanceDatabase | null = null;
let activeFinanceConnectionUrl: string | null = null;
let cachedFinanceSecret: { name: string; value: string; expiresAt: number } | null = null;

type PostCommitAction = () => void | Promise<void>;
const pendingAfterCommit = new WeakMap<object, PostCommitAction[]>();

/** Existing audit/notification callbacks run only after the outer Finance commit. */
export function onMarketplaceFinanceCommit(session: object, action: PostCommitAction): void {
  const pending = pendingAfterCommit.get(session);
  if (!pending) throw new Error("DEV_FINANCE_POST_COMMIT_SCOPE_INVALID");
  pending.push(action);
}

/** Keep Finance credentials separate from the shared postgres/PROD secret.
 * An explicitly named dedicated GCP Secret Manager secret is supported when
 * APP_ENV is development; there is never a fallback to the shared DB secret.
 * The existing GCP service account bootstrap remains the only secret reader.
 */
export async function resolveMarketplaceFinanceDevDatabaseUrl(
  secretReader: (secretName: string) => Promise<string> = readSecret,
): Promise<string> {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true") {
    throw new Error("DEV_FINANCE_DISABLED");
  }
  const direct = process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV?.trim();
  const secretName = process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV?.trim();
  if (direct && secretName) throw new Error("DEV_FINANCE_CREDENTIAL_SOURCE_AMBIGUOUS");
  if (!direct && !secretName) throw new Error("DEV_FINANCE_CREDENTIAL_NOT_CONFIGURED");
  if (secretName && !/^bizportal-marketplace-finance-dev(?:-[a-z0-9-]+)?$/.test(secretName)) {
    throw new Error("DEV_FINANCE_SECRET_NAME_INVALID");
  }

  let raw = direct;
  if (secretName) {
    if (cachedFinanceSecret && cachedFinanceSecret.name === secretName &&
        cachedFinanceSecret.expiresAt > Date.now()) {
      raw = cachedFinanceSecret.value;
    } else {
      raw = (await secretReader(secretName)).trim();
      if (!raw) throw new Error("DEV_FINANCE_SECRET_EMPTY");
      cachedFinanceSecret = { name: secretName, value: raw, expiresAt: Date.now() + 60_000 };
    }
  }
  if (!raw) throw new Error("DEV_FINANCE_CREDENTIAL_NOT_CONFIGURED");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("DEV_FINANCE_DATABASE_URL_INVALID"); }
  const username = decodeURIComponent(url.username);
  const hostname = url.hostname.toLowerCase();
  const trustedHost = hostname === `db.${EXPECTED_PROJECT}.supabase.co` ||
    hostname.endsWith(".pooler.supabase.com");
  const trustedUser = username === EXPECTED_ROLE ||
    username === `${EXPECTED_ROLE}.${EXPECTED_PROJECT}`;
  const projectBound = hostname.includes(EXPECTED_PROJECT) || username.includes(EXPECTED_PROJECT);
  if (!["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")) {
    throw new Error("DEV_FINANCE_DATABASE_SSL_REQUIRED");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !trustedHost || !trustedUser || !projectBound || !url.password ||
      raw.includes("nzdweipzckfszczzqtuw")) {
    throw new Error("DEV_FINANCE_DATABASE_IDENTITY_INVALID");
  }
  return raw;
}

/** Hostinger lacks the VPS-only sslrootcert path contained in the DEV DSN.
 * Build explicit pg connection fields so node-postgres never reads that
 * inaccessible path. Direct Supabase connections use the pinned PUBLIC
 * Supabase 2021 root CA and always verify the TLS chain and hostname.
 * Pooler connections use system-trusted CAs, with the same strict TLS checks.
 * No private keys, credentials, or production DB fallback are bundled here.
 */
function secureFinancePoolOptions(raw: string): pg.PoolConfig {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  const directHost = `db.${EXPECTED_PROJECT}.supabase.co`;
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  const port = Number(url.port || 5432);

  if ((hostname !== directHost && !hostname.endsWith(".pooler.supabase.com")) ||
      (user !== EXPECTED_ROLE && user !== `${EXPECTED_ROLE}.${EXPECTED_PROJECT}`) ||
      !Number.isSafeInteger(port) || ![5432, 6543].includes(port) ||
      database !== "postgres" || !url.password) {
    throw new Error("DEV_FINANCE_DATABASE_TARGET_INVALID");
  }

  let ca: string | undefined;
  if (hostname === directHost) {
    const cert = new X509Certificate(SUPABASE_FINANCE_ROOT_2021_PEM);
    if (!cert.ca ||
        cert.fingerprint256.toUpperCase() !== SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256) {
      throw new Error("DEV_FINANCE_PINNED_CA_INVALID");
    }
    ca = SUPABASE_FINANCE_ROOT_2021_PEM;
  }

  return {
    host: hostname, port, user,
    password: decodeURIComponent(url.password),
    database,
    ssl: { rejectUnauthorized: true, servername: hostname, ...(ca ? { ca } : {}) },
    max: 1, connectionTimeoutMillis: 8000, idleTimeoutMillis: 5000,
    query_timeout: 20000, application_name: "bizportal-finance-dev",
  };
}

async function getFinanceDb(): Promise<FinanceDatabase> {
  const url = await resolveMarketplaceFinanceDevDatabaseUrl();
  if (financePool && activeFinanceConnectionUrl !== url) {
    // Rotation requires a controlled service restart; never reuse a cached
    // authenticated pool after the configured source has changed.
    throw new Error("DEV_FINANCE_CREDENTIAL_CHANGED_RESTART_REQUIRED");
  }
  if (!financePool) {
    financePool = new pg.Pool(secureFinancePoolOptions(url));
    financeDb = drizzle(financePool, { schema });
    activeFinanceConnectionUrl = url;
  }
  return financeDb!;
}

/** All canonical reads/writes must use this exact transaction connection.
 * Verified company scope is set transaction-locally, never from request payload.
 * Nested canonical service transactions use savepoints on this same client.
 */
export async function withMarketplaceFinanceDevTransaction<T>(
  companyId: number, work: (session: ScopedDb) => Promise<T>,
  options: { readOnly?: boolean; paymentApprovalOnly?: boolean } = {},
): Promise<T> {
  // A previously initialized Finance pool is not a grant to write. The
  // independent read-only feature must never activate the writer helper.
  const approvalOnly=options.paymentApprovalOnly===true;
  if (approvalOnly && (options.readOnly===true ||
      process.env.APP_ENV !== "development" ||
      process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV !== "true" ||
      process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV !== "true")) {
    throw new Error("DEV_FINANCE_PAYMENT_APPROVAL_DISABLED");
  }
  if (options.readOnly !== true && !approvalOnly &&
      process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true") {
    throw new Error("DEV_FINANCE_WRITER_DISABLED");
  }
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("DEV_FINANCE_COMPANY_INVALID");
  }
  const finance = await getFinanceDb();
  const afterCommit: PostCommitAction[] = [];
  const result = await finance.transaction(async (tx) => {
    pendingAfterCommit.set(tx, afterCommit);
    try {
    const identity = await tx.execute(sql`
      select current_user::text as db_role,
             session_user::text as login_role,
             coalesce((select rolsuper or rolbypassrls
                       from pg_catalog.pg_roles where rolname=current_user),true) as elevated,
             row_security_active('public.mkt_purchase_orders'::regclass) as po_rls,
             row_security_active('public.mkt_purchase_order_lines'::regclass) as po_lines_rls,
             row_security_active('public.mkt_po_shipments'::regclass) as shipments_rls,
             row_security_active('public.mkt_po_shipment_items'::regclass) as shipment_items_rls,
             row_security_active('public.mkt_po_goods_receipts'::regclass) as receipts_rls,
             row_security_active('public.mkt_po_goods_receipt_items'::regclass) as receipt_items_rls,
             row_security_active('public.vendor_invoices'::regclass) as invoice_rls,
             row_security_active('public.vendor_invoice_lines'::regclass) as invoice_lines_rls,
             row_security_active('public.mkt_ap_preparations'::regclass) as ap_rls,
             row_security_active('public.payment_requests'::regclass) as payment_rls,
             row_security_active('public.mkt_accounting_handoffs'::regclass) as handoff_rls
    `);
    const role = identity.rows[0];
    if (role?.db_role !== EXPECTED_ROLE || role?.login_role !== EXPECTED_ROLE ||
        role?.elevated !== false ||
        role?.po_rls !== true || role?.po_lines_rls !== true ||
        role?.shipments_rls !== true || role?.shipment_items_rls !== true ||
        role?.receipts_rls !== true || role?.receipt_items_rls !== true ||
        role?.invoice_rls !== true || role?.invoice_lines_rls !== true ||
        role?.ap_rls !== true || role?.payment_rls !== true ||
        role?.handoff_rls !== true) {
      throw new Error("DEV_FINANCE_ROLE_OR_RLS_UNVERIFIED");
    }
    await tx.execute(sql`select set_config('app.marketplace_company_id', ${String(companyId)}, true)`);
    const bound = await tx.execute(sql`select current_setting('app.marketplace_company_id',true) as company_id`);
    if (bound.rows[0]?.company_id !== String(companyId)) {
      throw new Error("DEV_FINANCE_TENANT_BINDING_FAILED");
    }
    // A dedicated approval-only session must never register unrelated
    // post-commit callbacks (external notifications, payment dispatch).
    const value = await work(tx as unknown as ScopedDb);
    if (approvalOnly && afterCommit.length > 0) {
      throw new Error("DEV_FINANCE_PAYMENT_APPROVAL_SIDE_EFFECT_DENIED");
    }
    if (options.readOnly === true && afterCommit.length > 0) {
      throw new Error("DEV_FINANCE_READ_ONLY_SIDE_EFFECT_DENIED");
    }
    return value;
    } finally {
      pendingAfterCommit.delete(tx);
    }
  });
  // No audit or external notification is sent after a failed/rolled-back commit.
  for (const action of afterCommit) await action();
  return result;
}
