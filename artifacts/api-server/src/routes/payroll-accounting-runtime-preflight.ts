import type { Pool, PoolClient } from "pg";

/** Server-only, read-only structural gate. Does not acquire credentials, use
 * SET ROLE, repair DDL/ACLs, inspect salaries, bind HTTP or call a journal writer.
 * Policy presence is NOT proof of policy semantics or authenticated E2E.
 * The native artifact, endpoint/TLS pinning and user session have separate gates.
 */
export const PAYROLL_SETTLEMENT_ROLE = "bizportal_payroll_settlement_dev";
export const PAYROLL_SETTLEMENT_TABLES = [
  { table: "accounting_entries", insert: ["id"], update: ["status", "checksum_hash", "previous_entry_id"],
    denyUpdate: ["company_id", "source", "source_id", "total_debit", "total_credit"], sequence: true },
  { table: "accounting_entry_lines", insert: ["id"], update: ["id"], denyUpdate: ["account_id", "debit", "credit"], sequence: true },
  { table: "journal_sequences", insert: ["journal_prefix", "company_id", "year", "next_seq"], update: ["next_seq"], denyUpdate: ["company_id"] },
  { table: "ledger_events", insert: ["company_id", "event_type", "period", "entry_id", "ledger_entry_id", "actor", "payload"], sequence: true },
  { table: "financial_outbox_events", insert: ["event_type", "payload", "entry_id", "company_id"], sequence: true },
  { table: "payroll_runs", update: ["status", "posting_status", "accounting_entry_id", "posted_at", "posting_error", "posting_claimed_at"],
    denyUpdate: ["company_id", "year", "month", "approved_at", "notes", "payment_entry_id"] },
  { table: "payroll_items", update: ["id"], denyUpdate: ["base_salary", "allowance", "net_salary", "is_paid", "employee_id", "run_id"] },
  { table: "cash_advances", update: ["paid_amount", "settled_amount", "remaining_amount", "status", "lifecycle_status", "repayment_journal_id", "repaid_at", "updated_at"],
    denyUpdate: ["company_id", "employee_id", "amount", "receivable_account_id"] },
  { table: "cash_advance_repayments", insert: ["advance_id", "amount", "payment_method", "date", "notes", "entry_id", "idempotency_key", "posted_at", "created_by", "payment_reference"],
    update: ["id"], denyUpdate: ["advance_id", "amount", "entry_id"], sequence: true },
  { table: "payroll_kasbon_auto_reservations", update: ["state", "confirmed_at"], denyUpdate: ["company_id", "amount", "run_id", "advance_id", "balance_at_preparation"] },
  { table: "fleet_ledger_entries", insert: ["company_id", "ledger_date", "period", "source_type", "source_id", "source_ref", "account_id", "account_code", "account_name", "account_type", "debit", "credit", "description", "created_by"],
    update: ["id"], denyUpdate: ["company_id", "debit", "credit", "is_voided"], sequence: true },
  { table: "employees", update: ["id"], denyUpdate: ["company_id", "status"] },
  { table: "chart_of_accounts", update: ["id"], denyUpdate: ["company_id", "type", "is_active", "is_postable"] },
  { table: "accounting_journals", denyUpdate: ["company_id", "type"] },
  { table: "financial_periods", update: ["company_id"], denyUpdate: ["is_closed", "override_allowed"] },
  { table: "accounting_settings", update: ["id"], denyUpdate: ["salary_expense_account_id", "allowance_expense_account_id", "salary_payable_account_id", "tax_payable_account_id", "bpjs_payable_account_id"] },
  { table: "payroll_cash_advance_allocations" },
  { table: "cash_advance_installment_schedules" },
] as const;

// OIDs and attribute numbers avoid calling privilege functions with nonexistent
// table/column names. Fixed schema/table contract only; no caller SQL fragments.
export const PAYROLL_SETTLEMENT_CATALOG_SQL = `
WITH contract AS (
 SELECT x->>'table' AS name,x FROM jsonb_array_elements($1::jsonb) x
), objects AS (
 SELECT k.name,k.x,c.oid,c.relkind,c.relrowsecurity,c.relowner,
 CASE WHEN c.oid IS NOT NULL AND k.x->>'sequence'='true'
 THEN pg_get_serial_sequence(format('public.%I',k.name),'id') END AS sequence_name
 FROM contract k LEFT JOIN pg_namespace n ON n.nspname='public'
 LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=k.name
), checks AS (
 SELECT o.name, o.oid IS NOT NULL AND o.relkind IN ('r','p') AS table_present,
 COALESCE(o.relrowsecurity,false) AS rls_enabled,
 COALESCE(pg_has_role(current_user,o.relowner,'USAGE'),false) AS owns_table,
 COALESCE(has_table_privilege(current_user,o.oid,'SELECT'),false) AS can_select,
 COALESCE(has_table_privilege(current_user,o.oid,'UPDATE'),false) AS broad_update,
 COALESCE(has_table_privilege(current_user,o.oid,'DELETE'),false) OR
 COALESCE(has_table_privilege(current_user,o.oid,'TRUNCATE'),false) AS destructive,
 (SELECT COALESCE(bool_and(a.attnum IS NOT NULL AND has_column_privilege(current_user,o.oid,a.attnum,'INSERT')),true)
  FROM jsonb_array_elements_text(COALESCE(o.x->'insert','[]'::jsonb)) v
  LEFT JOIN pg_attribute a ON a.attrelid=o.oid AND a.attname=v.value AND NOT a.attisdropped) AS insert_columns,
 (SELECT COALESCE(bool_and(a.attnum IS NOT NULL AND has_column_privilege(current_user,o.oid,a.attnum,'UPDATE')),true)
  FROM jsonb_array_elements_text(COALESCE(o.x->'update','[]'::jsonb)) v
  LEFT JOIN pg_attribute a ON a.attrelid=o.oid AND a.attname=v.value AND NOT a.attisdropped) AS update_columns,
 EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(o.x->'denyUpdate','[]'::jsonb)) v
  JOIN pg_attribute a ON a.attrelid=o.oid AND a.attname=v.value AND NOT a.attisdropped
  WHERE has_column_privilege(current_user,o.oid,a.attnum,'UPDATE')) AS forbidden_update,
 CASE WHEN o.x->>'sequence'='true' THEN o.sequence_name IS NOT NULL AND
  has_sequence_privilege(current_user,o.sequence_name,'USAGE') ELSE true END AS sequence_access,
 EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=o.oid AND p.polpermissive AND p.polcmd IN ('*','r')
  AND (0=ANY(p.polroles) OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=ANY(p.polroles) AND pg_has_role(current_user,r.oid,'USAGE')))) AS select_policy,
 NOT(o.x ? 'insert') OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=o.oid AND p.polpermissive AND p.polcmd IN ('*','a')
  AND (0=ANY(p.polroles) OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=ANY(p.polroles) AND pg_has_role(current_user,r.oid,'USAGE')))) AS insert_policy,
 NOT(o.x ? 'update') OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=o.oid AND p.polpermissive AND p.polcmd IN ('*','w')
  AND (0=ANY(p.polroles) OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=ANY(p.polroles) AND pg_has_role(current_user,r.oid,'USAGE')))) AS update_policy
 FROM objects o
) SELECT * FROM checks ORDER BY name`;

type Identity = { actor: string; login: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean;
  rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; read_only: string;
  isolation: string; schema_create: boolean; alternate_role: boolean; payout_write: boolean };
type Check = { name: string; table_present: boolean; rls_enabled: boolean; owns_table: boolean;
  can_select: boolean; broad_update: boolean; destructive: boolean; insert_columns: boolean;
  update_columns: boolean; forbidden_update: boolean; sequence_access: boolean; select_policy: boolean;
  insert_policy: boolean; update_policy: boolean };
const fail = (): never => { throw Error("PAYROLL_RUNTIME_PREFLIGHT_REJECTED"); };

export async function verifyPayrollSettlementRuntime(pool: Pick<Pool, "connect">) {
  if (process.env.APP_ENV !== "development") throw Error("PAYROLL_RUNTIME_PREFLIGHT_DEV_ONLY");
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch { throw Error("PAYROLL_RUNTIME_PREFLIGHT_REJECTED"); }
  let discard: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '8s'");
    const identities = await client.query<Identity>(`SELECT current_user AS actor,session_user AS login,
      rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
      current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
      has_schema_privilege(current_user,'public','CREATE') AS schema_create,
      EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND
        (pg_has_role(r.oid,other.oid,'USAGE') OR pg_has_role(r.oid,other.oid,'SET'))) AS alternate_role,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='salary_payments' AND
        (has_table_privilege(r.oid,c.oid,'INSERT') OR has_any_column_privilege(r.oid,c.oid,'INSERT') OR
         has_table_privilege(r.oid,c.oid,'UPDATE') OR has_any_column_privilege(r.oid,c.oid,'UPDATE') OR
         has_table_privilege(r.oid,c.oid,'DELETE') OR has_table_privilege(r.oid,c.oid,'TRUNCATE'))) AS payout_write
      FROM pg_roles r WHERE r.rolname=current_user`);
    const identity = identities.rows[0];
    if (identities.rows.length !== 1 || !identity || identity.actor !== PAYROLL_SETTLEMENT_ROLE ||
        identity.login !== identity.actor || identity.rolcanlogin !== true || identity.read_only !== "on" ||
        identity.isolation !== "repeatable read" ||
        [identity.rolsuper,identity.rolbypassrls,identity.rolcreaterole,identity.rolcreatedb,
         identity.rolreplication,identity.schema_create,identity.alternate_role,identity.payout_write].some(v => v !== false)) fail();
    const checks = await client.query<Check>(PAYROLL_SETTLEMENT_CATALOG_SQL, [JSON.stringify(PAYROLL_SETTLEMENT_TABLES)]);
    const expected = new Set<string>(PAYROLL_SETTLEMENT_TABLES.map(t => t.table));
    if (checks.rows.length !== expected.size || new Set(checks.rows.map(r => r.name)).size !== expected.size) fail();
    for (const r of checks.rows) {
      if (!expected.has(r.name) || [r.table_present,r.rls_enabled,r.can_select,r.insert_columns,r.update_columns,
          r.sequence_access,r.select_policy,r.insert_policy,r.update_policy].some(v => v !== true) ||
          [r.owns_table,r.broad_update,r.destructive,r.forbidden_update].some(v => v !== false)) fail();
    }
    await client.query("ROLLBACK");
    return Object.freeze({ structuralChecksPassed: true as const, checkedTables: expected.size, readOnly: true as const,
      runtimePostingTested: false as const, policySemanticsVerified: false as const });
  } catch {
    try { await client.query("ROLLBACK"); }
    catch { discard = Error("PAYROLL_RUNTIME_PREFLIGHT_ROLLBACK_FAILED"); }
    // Do not expose SQL, DSN, raw errors, role names or catalog details over HTTP.
    throw Error("PAYROLL_RUNTIME_PREFLIGHT_REJECTED");
  } finally { client.release(discard); }
}
