/**
 * CST-DEV dedicated Marketplace Finance DB direct-login smoke test.
 * Standalone, read-only, no service changes, no finance writes.
 * Uses the same GCP Secret Manager reader and strict credential validation
 * as the canonical Finance DEV session. Never prints secrets/URLs.
 */
import pg from "pg";
import { resolveMarketplaceFinanceDevDatabaseUrl } from "../lib/db/src/marketplace-finance-dev";

const EXPECTED_ROLE = "bizportal_marketplace_finance_login_dev";
const TABLES = [
  "mkt_purchase_orders", "mkt_purchase_order_lines",
  "mkt_po_shipments", "mkt_po_shipment_items",
  "mkt_po_goods_receipts", "mkt_po_goods_receipt_items",
  "vendor_invoices", "vendor_invoice_lines",
  "mkt_ap_preparations", "payment_requests", "mkt_accounting_handoffs",
] as const;

async function main(): Promise<void> {
  if (process.env.APP_ENV !== "development" ||
      process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true" ||
      process.env.PR50_FINANCE_READONLY_PROBE !== "true") {
    throw new Error("PROBE_NOT_EXPLICITLY_AUTHORIZED");
  }
  const url = await resolveMarketplaceFinanceDevDatabaseUrl();
  // The URL has already been validated for CST-DEV, the dedicated role,
  // permitted TLS modes, and no fallback to the shared postgres connection.
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 8000,
    query_timeout: 15000,
    application_name: "bizportal-pr50-finance-readonly-probe",
  });
  try {
    await client.connect();
    for (const company of [null, 1, 3] as const) {
      await client.query("BEGIN READ ONLY");
      try {
        if (company !== null) {
          await client.query("select set_config('app.marketplace_company_id',$1,true)", [String(company)]);
        }
        const role = await client.query(`
          SELECT current_user::text AS effective_role,
                 session_user::text AS login_role,
                 COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles
                           WHERE rolname=current_user), TRUE) AS elevated,
                 (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls_active,
                 current_setting('transaction_read_only') AS read_only,
                 current_setting('app.marketplace_company_id',true) AS tenant
        `);
        const ident = role.rows[0];
        if (!ident || ident.effective_role !== EXPECTED_ROLE ||
            ident.login_role !== EXPECTED_ROLE || ident.elevated !== false ||
            ident.tls_active !== true || ident.read_only !== "on" ||
            (company === null ? Boolean(ident.tenant) : ident.tenant !== String(company))) {
          throw new Error("FINANCE_DIRECT_LOGIN_IDENTITY_OR_TLS_FAILED");
        }
        const flags = TABLES.map((table, i) =>
          `row_security_active('public.${table}'::regclass) AS rls_${i}`).join(", ");
        const rls = await client.query(`SELECT ${flags}`);
        if (!TABLES.every((_, i) => rls.rows[0][`rls_${i}`] === true)) {
          throw new Error("FINANCE_DIRECT_LOGIN_RLS_INCOMPLETE");
        }
        const acl = await client.query(`
          SELECT has_table_privilege(current_user,'public.users','SELECT') AS users_read,
                 has_table_privilege(current_user,'public.bizportal_email_otp_codes','SELECT') AS otp_read,
                 has_table_privilege(current_user,'public.accounting_entries','INSERT') AS gl_insert
        `);
        if (Object.values(acl.rows[0]).some(Boolean)) throw new Error("FINANCE_DIRECT_LOGIN_EXCESS_PRIVILEGE");
        const counts = await client.query(`
          SELECT (SELECT count(*)::int FROM public.mkt_purchase_orders) AS scoped_po,
                 (SELECT count(*)::int FROM public.vendor_invoices) AS scoped_invoice,
                 (SELECT count(*)::int FROM public.mkt_ap_preparations) AS scoped_ap,
                 (SELECT count(*)::int FROM public.mkt_accounting_handoffs) AS scoped_handoff
        `);
        if (company === null && Object.values(counts.rows[0]).some((v) => Number(v) !== 0)) {
          throw new Error("FINANCE_DIRECT_LOGIN_UNBOUND_TENANT_LEAK");
        }
        console.log(`FINANCE_DEV_READONLY_COMPANY_${company ?? "UNBOUND"}=PASS`);
      } finally {
        await client.query("ROLLBACK");
      }
    }
    console.log("FINANCE_DIRECT_TLS_RLS_READONLY_PASS=true");
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // Never print caught connection error messages because providers may include
  // host/user/URL details. Only a predefined code or SQLSTATE may be logged.
  const known = error instanceof Error && /^[A-Z][A-Z0-9_]{4,80}$/.test(error.message)
    ? error.message : "FINANCE_DIRECT_READONLY_PROBE_FAILED";
  console.error(`FINANCE_DIRECT_READONLY_RESULT=${known}`);
  process.exitCode = 1;
});
