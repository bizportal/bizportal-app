import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

type ScopedDb = typeof import("./index").db;
type FinanceDatabase = ReturnType<typeof drizzle<typeof schema>>;

const EXPECTED_PROJECT = "xssrfshdrtdfupgqwfdw";
const EXPECTED_ROLE = "bizportal_marketplace_finance_login_dev";
let financePool: pg.Pool | null = null;
let financeDb: FinanceDatabase | null = null;

type PostCommitAction = () => void | Promise<void>;
const pendingAfterCommit = new WeakMap<object, PostCommitAction[]>();

/** Existing audit/notification callbacks run only after the outer Finance commit. */
export function onMarketplaceFinanceCommit(session: object, action: PostCommitAction): void {
  const pending = pendingAfterCommit.get(session);
  if (!pending) throw new Error("DEV_FINANCE_POST_COMMIT_SCOPE_INVALID");
  pending.push(action);
}

/** Dedicated DEV finance identity. Never fall back to shared postgres or PROD. */
function getDedicatedFinanceUrl(): string {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true") {
    throw new Error("DEV_FINANCE_DISABLED");
  }
  const raw = process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV?.trim();
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

function getFinanceDb(): FinanceDatabase {
  const url = getDedicatedFinanceUrl();
  if (!financePool) {
    financePool = new pg.Pool({
      connectionString: url, max: 1,
      connectionTimeoutMillis: 8000, idleTimeoutMillis: 5000,
      query_timeout: 20000, application_name: "bizportal-finance-dev",
    });
    financeDb = drizzle(financePool, { schema });
  }
  return financeDb!;
}

/** All canonical reads/writes must use this exact transaction connection.
 * Verified company scope is set transaction-locally, never from request payload.
 * Nested canonical service transactions use savepoints on this same client.
 */
export async function withMarketplaceFinanceDevTransaction<T>(
  companyId: number, work: (session: ScopedDb) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error("DEV_FINANCE_COMPANY_INVALID");
  }
  const finance = getFinanceDb();
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
    return await work(tx as unknown as ScopedDb);
    } finally {
      pendingAfterCommit.delete(tx);
    }
  });
  // No audit or external notification is sent after a failed/rolled-back commit.
  for (const action of afterCommit) await action();
  return result;
}
