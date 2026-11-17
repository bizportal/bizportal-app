import pg from "pg";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
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
/** Explicit DEV-only company roles. No role or secret can be supplied by a request. */
const COMPANY_FINANCE_IDENTITIES = {
  1: { role: "bizportal_finance_cst_login_dev", secret: "bizportal-marketplace-finance-dev-cst" },
  3: { role: "bizportal_finance_diva_login_dev", secret: "bizportal-marketplace-finance-dev-diva" },
} as const;
type CompanyFinanceId = keyof typeof COMPANY_FINANCE_IDENTITIES;
const COMPANY_MODE_FLAG = "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV";
// Separate PostgreSQL LOGIN roles remain mandatory even when GCP stores both URLs in one secret.
const COMPANY_BUNDLE_MODE_FLAG = "BIZPORTAL_MARKETPLACE_FINANCE_SINGLE_GCP_SECRET_DEV";
const COMPANY_BUNDLE_SECRET_NAME = "bizportal-marketplace-finance-dev-companies";
// A deliberate DEV-only bridge for existing company Secret Manager DSNs that
// point at direct IPv6-only Supabase. The host is pinned from the ALREADY
// VERIFIED existing CST-DEV Session Pooler, not from user input or an
// environment value. Do not mutate the GCP version, usernames or passwords.
const COMPANY_IPV4_POOLER_FLAG = "BIZPORTAL_MARKETPLACE_FINANCE_PINNED_IPV4_SESSION_POOLER_DEV";
const COMPANY_IPV4_POOLER_HOST = "aws-1-ap-southeast-2.pooler.supabase.com";
const companyFinancePools = new Map<CompanyFinanceId, {
  url: string; db: FinanceDatabase; pool: pg.Pool
}>();
const companyFinanceSecretCache = new Map<CompanyFinanceId, { value: string; expiresAt: number }>();
type CompanyFinanceUrls = Record<CompanyFinanceId, string>;
let companyBundleCache: { value: CompanyFinanceUrls; expiresAt: number } | null = null;
let companyBundlePending: Promise<CompanyFinanceUrls> | null = null;
/** A running process cannot change the database role or secret source without restart. */
let activeFinanceMode: "legacy" | "company-separate" | "company-bundle" | "company-bundle-ipv4" | null = null;

function companyIdentity(companyId: number) {
  if (!Number.isSafeInteger(companyId) ||
      !Object.prototype.hasOwnProperty.call(COMPANY_FINANCE_IDENTITIES, companyId)) {
    throw new Error("DEV_FINANCE_COMPANY_NOT_ALLOWLISTED");
  }
  return COMPANY_FINANCE_IDENTITIES[companyId as CompanyFinanceId];
}

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
function validateFinanceDatabaseUrl(raw: string, expectedRole: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("DEV_FINANCE_DATABASE_URL_INVALID"); }
  const username = decodeURIComponent(url.username);
  const hostname = url.hostname.toLowerCase();
  const trustedHost = hostname === `db.${EXPECTED_PROJECT}.supabase.co` ||
    hostname.endsWith(".pooler.supabase.com");
  const trustedUser = username === expectedRole ||
    username === `${expectedRole}.${EXPECTED_PROJECT}`;
  const projectBound = hostname.includes(EXPECTED_PROJECT) || username.includes(EXPECTED_PROJECT);
  const sslmode = url.searchParams.get("sslmode");
  if (!sslmode) {
    throw new Error("DEV_FINANCE_DATABASE_SSL_REQUIRED");
  }
  // pg-connection-string uses the LAST duplicate query parameter, whereas
  // URLSearchParams.get() returns the FIRST. Query params such as host, user,
  // sslmode or ssl can override validated authority/role or disable TLS.
  // Finance needs only these two SSL parameters; reject every extra key and
  // both duplicates BEFORE passing the unchanged URL to pg.Pool.
  const allowedParams = new Set(["sslmode", "sslrootcert"]);
  if ([...url.searchParams.keys()].some(key => !allowedParams.has(key)) ||
      url.searchParams.getAll("sslmode").length !== 1 ||
      url.searchParams.getAll("sslrootcert").length > 1) {
    throw new Error("DEV_FINANCE_DATABASE_QUERY_PARAMS_INVALID");
  }
  // pg-connection-string v2 currently treats sslmode=require and verify-ca
  // as aliases for verify-full; its v3/libpq semantics do not. Require CA
  // and hostname verification explicitly to prevent dependency downgrade.
  const sslrootcert = url.searchParams.get("sslrootcert");
  if (sslmode !== "verify-full" || !sslrootcert?.startsWith("/")) {
    throw new Error("DEV_FINANCE_DATABASE_VERIFIED_CA_REQUIRED");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !trustedHost || !trustedUser || !projectBound || !url.password ||
      raw.includes("nzdweipzckfszczzqtuw")) {
    throw new Error("DEV_FINANCE_DATABASE_IDENTITY_INVALID");
  }
  return raw;
}

/** Parse both company identities together; never authorize a company via user-supplied
 * JSON, a shared Finance login, or a partial/rotated secret. One GCP version
 * supplies two separate company-scoped PostgreSQL logins to the SAME DEV DB.
 * The secret is read once per cache window, including concurrent requests.
 */
async function readCompanyFinanceBundle(
  secretReader: (secretName: string) => Promise<string>,
): Promise<CompanyFinanceUrls> {
  if (companyBundleCache && companyBundleCache.expiresAt > Date.now()) {
    return companyBundleCache.value;
  }
  if (companyBundlePending) return companyBundlePending;
  const pending = (async (): Promise<CompanyFinanceUrls> => {
    const raw = await secretReader(COMPANY_BUNDLE_SECRET_NAME);
    if (!raw || Buffer.byteLength(raw, "utf8") > 8 * 1024) {
      throw new Error("DEV_FINANCE_COMPANY_BUNDLE_INVALID");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("DEV_FINANCE_COMPANY_BUNDLE_INVALID"); }
    const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
    if (!exact(parsed, ["version", "companies"]) || parsed.version !== 1 ||
        !exact(parsed.companies, ["1", "3"])) {
      throw new Error("DEV_FINANCE_COMPANY_BUNDLE_INVALID");
    }
    const urls = {} as CompanyFinanceUrls;
    for (const id of [1, 3] as const) {
      const item = parsed.companies[String(id)];
      const expected = companyIdentity(id);
      if (!exact(item, ["role", "databaseUrl"]) ||
          item.role !== expected.role || typeof item.databaseUrl !== "string") {
        throw new Error("DEV_FINANCE_COMPANY_BUNDLE_INVALID");
      }
      urls[id] = validateFinanceDatabaseUrl(item.databaseUrl, expected.role);
    }
    if (urls[1] === urls[3]) throw new Error("DEV_FINANCE_COMPANY_BUNDLE_INVALID");
    companyBundleCache = { value: urls, expiresAt: Date.now() + 60_000 };
    return urls;
  })();
  companyBundlePending = pending;
  try { return await pending; }
  finally {
    if (companyBundlePending === pending) companyBundlePending = null;
  }
}

export async function resolveMarketplaceFinanceDevDatabaseUrl(
  secretReader: (secretName: string) => Promise<string> = readSecret,
): Promise<string> {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      (process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true" &&
       process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV !== "true")) {
    throw new Error("DEV_FINANCE_DISABLED");
  }
  if (process.env[COMPANY_MODE_FLAG] === "true") {
    throw new Error("DEV_FINANCE_LEGACY_ROLE_DISABLED_IN_COMPANY_MODE");
  }
  if (process.env[COMPANY_BUNDLE_MODE_FLAG] === "true") {
    throw new Error("DEV_FINANCE_BUNDLE_REQUIRES_COMPANY_MODE");
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
  return validateFinanceDatabaseUrl(raw, EXPECTED_ROLE);
}

/** Retrieve only the explicitly pinned company secret; no user/env-driven
 * credential selection and no shared postgres or generic Finance fallback.
 * The real live secrets are NOT created by this source-only proposal.
 */
export async function resolveMarketplaceFinanceCompanyDevDatabaseUrl(
  companyId: number,
  secretReader: (secretName: string) => Promise<string> = readSecret,
): Promise<string> {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      (process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true" &&
       process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV !== "true")) {
    throw new Error("DEV_FINANCE_DISABLED");
  }
  if (process.env[COMPANY_MODE_FLAG] !== "true") {
    throw new Error("DEV_FINANCE_COMPANY_MODE_DISABLED");
  }
  const identity = companyIdentity(companyId);
  if (process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV?.trim() ||
      process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV?.trim()) {
    throw new Error("DEV_FINANCE_LEGACY_CREDENTIAL_IN_COMPANY_MODE");
  }
  const id = companyId as CompanyFinanceId;
  if (process.env[COMPANY_BUNDLE_MODE_FLAG] === "true") {
    return (await readCompanyFinanceBundle(secretReader))[id];
  }
  const cache = companyFinanceSecretCache.get(id);
  let raw: string;
  if (cache && cache.expiresAt > Date.now()) {
    raw = cache.value;
  } else {
    raw = (await secretReader(identity.secret)).trim();
    if (!raw) throw new Error("DEV_FINANCE_COMPANY_SECRET_EMPTY");
  }
  const validated = validateFinanceDatabaseUrl(raw, identity.role);
  if (!cache || cache.value !== validated || cache.expiresAt <= Date.now()) {
    companyFinanceSecretCache.set(id, { value: validated, expiresAt: Date.now() + 60_000 });
  }
  return validated;
}

/** Hostinger lacks the VPS-only sslrootcert path contained in the DEV DSN.
 * Build explicit pg connection fields so node-postgres never reads that
 * inaccessible path. Direct Supabase connections use the pinned PUBLIC
 * Supabase 2021 root CA and always verify the TLS chain and hostname.
 * Pooler connections use system-trusted CAs, with the same strict TLS checks.
 * No private keys, credentials, or production DB fallback are bundled here.
 */
function secureFinancePoolOptions(raw: string, expectedRole = EXPECTED_ROLE): pg.PoolConfig {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  const directHost = `db.${EXPECTED_PROJECT}.supabase.co`;
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  const port = Number(url.port || 5432);

  if ((hostname !== directHost && !hostname.endsWith(".pooler.supabase.com")) ||
      (user !== expectedRole && user !== `${expectedRole}.${EXPECTED_PROJECT}`) ||
      !Number.isSafeInteger(port) || ![5432, 6543].includes(port) ||
      database !== "postgres" || !url.password) {
    throw new Error("DEV_FINANCE_DATABASE_TARGET_INVALID");
  }

  // Supabase direct DB resolves IPv6 only in CST-DEV; the already-existing
  // Session Pooler resolves IPv4. Both present chains requiring Supabase's
  // pinned public root. For pooler, retain system roots plus this specific
  // approved root exactly as the already-PASS DEV admin TLS QA does.
  // Never disable certificate or hostname verification, and never use the
  // privileged shared postgres connection as a company-role fallback.
  const cert = new X509Certificate(SUPABASE_FINANCE_ROOT_2021_PEM);
  if (!cert.ca ||
      cert.fingerprint256.toUpperCase() !== SUPABASE_FINANCE_ROOT_2021_FINGERPRINT256) {
    throw new Error("DEV_FINANCE_PINNED_CA_INVALID");
  }
  const bridge = process.env[COMPANY_IPV4_POOLER_FLAG] === "true";
  const companyRole = Object.values(COMPANY_FINANCE_IDENTITIES)
    .some(identity => identity.role === expectedRole);
  if (bridge && (
    process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
    process.env[COMPANY_MODE_FLAG] !== "true" ||
    process.env[COMPANY_BUNDLE_MODE_FLAG] !== "true" ||
    !companyRole ||
    hostname !== directHost || user !== expectedRole ||
    port !== 5432 || database !== "postgres" ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    !url.searchParams.get("sslrootcert")?.startsWith("/")
  )) {
    throw new Error("DEV_FINANCE_IPV4_POOLER_BRIDGE_REFUSED");
  }
  const poolHost = bridge ? COMPANY_IPV4_POOLER_HOST : hostname;
  const poolUser = bridge ? `${expectedRole}.${EXPECTED_PROJECT}` : user;
  // Existing verified public Supabase root + system roots for Session Pooler;
  // direct connections retain the explicitly pinned Supabase root.
  const ca = poolHost === directHost
    ? SUPABASE_FINANCE_ROOT_2021_PEM
    : [...rootCertificates, SUPABASE_FINANCE_ROOT_2021_PEM].join("\n");

  return {
    host: poolHost, port, user: poolUser,
    password: decodeURIComponent(url.password),
    database,
    ssl: { rejectUnauthorized: true, servername: poolHost, ca },
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

async function getCompanyFinanceDb(companyId: number): Promise<FinanceDatabase> {
  const identity = companyIdentity(companyId);
  const id = companyId as CompanyFinanceId;
  const raw = await resolveMarketplaceFinanceCompanyDevDatabaseUrl(id);
  const previous = companyFinancePools.get(id);
  if (previous && previous.url !== raw) {
    // Existing authenticated pool is never silently reused after secret rotation.
    throw new Error("DEV_FINANCE_COMPANY_CREDENTIAL_CHANGED_RESTART_REQUIRED");
  }
  if (previous) return previous.db;
  const pool = new pg.Pool(secureFinancePoolOptions(raw, identity.role));
  const scoped = drizzle(pool, { schema });
  companyFinancePools.set(id, { url: raw, pool, db: scoped });
  return scoped;
}

/** All canonical reads/writes must use this exact transaction connection.
 * Verified company scope is set transaction-locally, never from request payload.
 * Nested canonical service transactions use savepoints on this same client.
 */
export async function withMarketplaceFinanceDevTransaction<T>(
  companyId: number, work: (session: ScopedDb) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  // A previously initialized Finance pool is not a grant to write. The
  // independent read-only feature must never activate the writer helper.
  if (options.readOnly !== true
      && process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true") {
    throw new Error("DEV_FINANCE_WRITER_DISABLED");
  }
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("DEV_FINANCE_COMPANY_INVALID");
  }
  const companyMode = process.env[COMPANY_MODE_FLAG] === "true";
  const requestedMode = companyMode
    ? (process.env[COMPANY_BUNDLE_MODE_FLAG] === "true"
      ? (process.env[COMPANY_IPV4_POOLER_FLAG] === "true" ? "company-bundle-ipv4" : "company-bundle")
      : "company-separate")
    : "legacy";
  if (activeFinanceMode && activeFinanceMode !== requestedMode) {
    throw new Error("DEV_FINANCE_CREDENTIAL_MODE_CHANGED_RESTART_REQUIRED");
  }
  const expectedRole = companyMode ? companyIdentity(companyId).role : EXPECTED_ROLE;
  const finance = companyMode
    ? await getCompanyFinanceDb(companyId)
    : await getFinanceDb();
  activeFinanceMode = requestedMode;
  const afterCommit: PostCommitAction[] = [];
  const result = await finance.transaction(async (tx) => {
    // Enforce PostgreSQL READ ONLY before the first query on this transaction.
    if (options.readOnly === true) await tx.execute(sql`SET TRANSACTION READ ONLY`);
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
    if (role?.db_role !== expectedRole || role?.login_role !== expectedRole ||
        role?.elevated !== false ||
        role?.po_rls !== true || role?.po_lines_rls !== true ||
        role?.shipments_rls !== true || role?.shipment_items_rls !== true ||
        role?.receipts_rls !== true || role?.receipt_items_rls !== true ||
        role?.invoice_rls !== true || role?.invoice_lines_rls !== true ||
        role?.ap_rls !== true || role?.payment_rls !== true ||
        role?.handoff_rls !== true) {
      throw new Error("DEV_FINANCE_ROLE_OR_RLS_UNVERIFIED");
    }
    if (companyMode) {
      // RLS "enabled" alone is not proof of tenant isolation. Require a
      // company-role RESTRICTIVE policy on EACH canonical Marketplace,
      // Finance AP and Accounting relation before executing business code.
      // This is a readiness gate, not a substitute for policy review.
      const readiness = await tx.execute(sql`
        SELECT
          count(DISTINCT c.relname)::integer AS guarded_tables,
          coalesce((
            SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls
            FROM pg_catalog.pg_roles WHERE rolname=current_user
          ),false) AS isolated_login,
          (SELECT count(*)::integer FROM pg_catalog.pg_auth_members m
             WHERE m.member=(SELECT oid FROM pg_catalog.pg_roles
                             WHERE rolname=current_user)) AS memberships
        FROM pg_catalog.pg_policy p
          JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relrowsecurity
          AND NOT p.polpermissive
          AND p.polcmd='*'  -- FOR ALL: protect reads AND every existing write action
          AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
              = ANY(p.polroles)
          AND c.relname IN (
            'mkt_purchase_orders', 'mkt_purchase_order_lines',
            'mkt_po_shipments', 'mkt_po_shipment_items',
            'mkt_po_goods_receipts', 'mkt_po_goods_receipt_items',
            'vendor_invoices', 'vendor_invoice_lines',
            'mkt_ap_preparations', 'payment_requests',
            'mkt_accounting_handoffs'
          )
      `);
      if (readiness.rows[0]?.guarded_tables !== 11 ||
          readiness.rows[0]?.isolated_login !== true ||
          readiness.rows[0]?.memberships !== 0) {
        throw new Error("DEV_FINANCE_COMPANY_RLS_GUARD_NOT_READY");
      }
    }
    await tx.execute(sql`select set_config('app.marketplace_company_id', ${String(companyId)}, true)`);
    const bound = await tx.execute(sql`select current_setting('app.marketplace_company_id',true) as company_id`);
    if (bound.rows[0]?.company_id !== String(companyId)) {
      throw new Error("DEV_FINANCE_TENANT_BINDING_FAILED");
    }
    const value = await work(tx as unknown as ScopedDb);
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

/** Existing verified TLS/role/RLS transaction, forced read-only at PostgreSQL. */
export function withMarketplaceFinanceDevReadOnlyTransaction<T>(
  companyId: number, work: (session: ScopedDb) => Promise<T>,
): Promise<T> {
  return withMarketplaceFinanceDevTransaction(companyId, work, { readOnly: true });
}
