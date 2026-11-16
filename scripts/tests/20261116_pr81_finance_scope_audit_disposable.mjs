import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import pg from "pg";

// Disposable GitHub Actions PostgreSQL only. No real DEV/PROD connection,
// and no fallback to environment-provided finance credentials.
const raw = process.env.FINANCE_RELATION_PG_E2E_URL;
if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true" || !raw) {
  throw new Error("REFUSE_NON_DISPOSABLE_FINANCE_AUDIT_TEST");
}
const url = new URL(raw);
if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
    url.port !== "65432" || url.pathname !== "/payroll_ci" ||
    url.username !== "postgres.xssrfshdrtdfupgqwfdw" ||
    url.search !== "" || url.hash !== "") {
  throw new Error("REFUSE_NON_DISPOSABLE_FINANCE_AUDIT_DATABASE");
}
const dirnameHere = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(dirnameHere, "../sql/20261116_pr81_finance_scope_audit_insert_STAGED.sql"), "utf8"
);
assert.match(migration, /CREATE POLICY pr81_finance_company_selection_audit_insert/);
assert.match(migration, /COMMIT;\s*$/);
const client = new pg.Client({
  host: "127.0.0.1", port: 65432, database: "payroll_ci",
  user: "postgres.xssrfshdrtdfupgqwfdw",
  password: decodeURIComponent(url.password),
  ssl: false, connectionTimeoutMillis: 5000,
});
let createdRole = false;
let createdTable = false;
const role = "bizportal_pr81_otp_login_dev";
const action = "finance_company_scope_selected";

async function attempt({ email = "admcst001@gmail.com", company = "1",
  entity = company, source = "signed_dev_superadmin", selected = Number(company),
  auditAction = action, entityType = "company", moduleName = "marketplace_finance" } = {}) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE " + role);
    await client.query("INSERT INTO public.audit_logs(user_email,action,entity_type,entity_id,after_data,company_id,module) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)",
      [email, auditAction, entityType, entity, JSON.stringify({ source, selectedCompanyId: selected }), company, moduleName]);
    await client.query("ROLLBACK");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code !== "42501") throw error;
    return false;
  }
}

try {
  await client.connect();
  const identity = await client.query("SELECT current_database() AS db, current_user AS actor");
  assert.equal(identity.rows[0].db, "payroll_ci");
  assert.equal(identity.rows[0].actor, "postgres.xssrfshdrtdfupgqwfdw");
  const roleExists = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
  assert.equal(roleExists.rowCount, 0, "Disposable role must not preexist");
  assert.equal((await client.query("SELECT to_regclass('public.audit_logs') AS existing")).rows[0].existing,
    null, "Disposable audit table must not preexist");
  await client.query("CREATE ROLE " + role + " NOLOGIN NOBYPASSRLS NOINHERIT");
  createdRole = true;
  await client.query(`CREATE TABLE public.audit_logs(
    user_email text, action text NOT NULL, entity_type text, entity_id text,
    after_data jsonb, company_id text, module text, ip_address text
  )`);
  createdTable = true;
  await client.query("ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY");
  await client.query("GRANT USAGE ON SCHEMA public TO " + role);
  await client.query("GRANT INSERT ON public.audit_logs TO " + role);
  await client.query(`CREATE POLICY pr81_auth_delivery_audit_insert ON public.audit_logs
    FOR INSERT TO bizportal_pr81_otp_login_dev WITH CHECK (
      lower(btrim(user_email))='admcst001@gmail.com'
      AND action='email_otp_delivery_failed'
      AND entity_type='auth' AND company_id='default' AND module='system'
    )`);
  const countBefore = await client.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs'");
  assert.equal(countBefore.rows[0].n, 1);

  // Execute the EXACT staged SQL, not an approximation of its predicate.
  await client.query(migration);
  const policies = await client.query("SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs' ORDER BY policyname");
  assert.deepEqual(policies.rows.map(r => r.policyname),
    ["pr81_auth_delivery_audit_insert", "pr81_finance_company_selection_audit_insert"]);
  assert.equal((await client.query("SELECT has_table_privilege($1,'public.audit_logs','SELECT') AS allowed", [role])).rows[0].allowed, false);
  assert.equal((await client.query("SELECT has_table_privilege($1,'public.audit_logs','INSERT') AS allowed", [role])).rows[0].allowed, true);

  assert.equal(await attempt({ company: "1" }), true, "CST audited selection");
  assert.equal(await attempt({ company: "3" }), true, "Diva audited selection");
  assert.equal(await attempt({ company: "2" }), false, "unallowlisted company");
  assert.equal(await attempt({ company: "1", entity: "3" }), false, "entity mismatch");
  assert.equal(await attempt({ company: "1", selected: 3 }), false, "metadata tenant mismatch");
  assert.equal(await attempt({ company: "1", source: "client_override" }), false, "untrusted source");
  assert.equal(await attempt({ company: "1", email: "other@example.invalid" }), false, "other actor");
  assert.equal(await attempt({ company: "1", auditAction: "arbitrary_finance_action" }), false, "wrong action");
  assert.equal(await attempt({ company: "1", entityType: "invoice" }), false, "wrong entity type");
  assert.equal(await attempt({ company: "1", moduleName: "other" }), false, "wrong module");

  // Prove the preexisting OTP failure audit still works, under the same role.
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE " + role);
  await client.query(`INSERT INTO public.audit_logs(user_email,action,entity_type,company_id,module)
    VALUES ('admcst001@gmail.com','email_otp_delivery_failed','auth','default','system')`);
  await client.query("ROLLBACK");

  assert.equal((await client.query("SELECT count(*)::int AS n FROM public.audit_logs")).rows[0].n, 0);
  console.log("PR87_DISPOSABLE_AUDIT_INSERT_PASS: allowlisted 1/3; 8 refusals; original OTP allowed; zero persisted rows");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  // Drop only objects successfully created by this test. A failed preflight
  // must not remove preexisting roles or tables.
  if (createdTable) await client.query("DROP TABLE public.audit_logs").catch(() => {});
  if (createdRole) {
    await client.query("REVOKE USAGE ON SCHEMA public FROM " + role).catch(() => {});
    await client.query("DROP ROLE " + role).catch(() => {});
  }
  await client.end().catch(() => {});
}
