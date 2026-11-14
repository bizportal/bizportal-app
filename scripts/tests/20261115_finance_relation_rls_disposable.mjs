import assert from "node:assert/strict";
import pg from "pg";

// NEVER run with real Supabase credentials or from any runtime host.
// This test requires the GitHub Actions disposable PostgreSQL service.
const raw = process.env.FINANCE_RELATION_PG_E2E_URL;
if (!raw || process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("REFUSE_NON_DISPOSABLE_FINANCE_TEST");
}
const url = new URL(raw);
if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
    url.port !== "65432" || url.pathname !== "/payroll_ci" ||
    url.username !== "postgres.xssrfshdrtdfupgqwfdw") {
  throw new Error("REFUSE_NON_DISPOSABLE_FINANCE_DATABASE");
}

const role = "ci_finance_relation_reader";
const vi = "public.ci_fin_rel_vi";
const ap = "public.ci_fin_rel_ap";
const pr = "public.ci_fin_rel_pr";
const handoff = "public.ci_fin_rel_handoff";
const scope = "nullif(current_setting('app.marketplace_company_id',true),'')::integer";
const pool = new pg.Pool({ connectionString: raw, max: 1 });
const checksOld = {
  ap: "company_id=" + scope + " AND EXISTS (SELECT 1 FROM " + vi +
      " vi WHERE vi.id=vendor_invoice_id AND vi.company_id=company_id" +
      " AND vi.three_way_match_status='passed')",
  pr: "company_id=" + scope + " AND source_type='marketplace_ap' AND status='draft'" +
      " AND journal_entry_id IS NULL AND EXISTS (SELECT 1 FROM " + ap +
      " parent_ap WHERE parent_ap.id=mkt_ap_preparation_id" +
      " AND parent_ap.company_id=company_id)",
  handoff: "company_id=" + scope + " AND accounting_status='draft_not_posted'" +
      " AND EXISTS (SELECT 1 FROM " + ap +
      " parent_ap WHERE parent_ap.id=ap_preparation_id AND parent_ap.company_id=company_id)" +
      " AND EXISTS (SELECT 1 FROM " + pr +
      " parent_pr WHERE parent_pr.id=payment_request_id AND parent_pr.company_id=company_id" +
      " AND parent_pr.source_type='marketplace_ap' AND parent_pr.status='draft')",
};
const checksFixed = {
  ap: "company_id=" + scope + " AND status='ap_preparation' AND EXISTS (SELECT 1 FROM " + vi +
      " vi WHERE vi.id=" + ap + ".vendor_invoice_id AND vi.company_id=" + ap +
      ".company_id AND vi.three_way_match_status='passed')",
  pr: "company_id=" + scope + " AND source_type='marketplace_ap' AND status='draft'" +
      " AND journal_entry_id IS NULL AND EXISTS (SELECT 1 FROM " + ap +
      " parent_ap WHERE parent_ap.id=" + pr + ".mkt_ap_preparation_id" +
      " AND parent_ap.company_id=" + pr + ".company_id)",
  handoff: "company_id=" + scope + " AND accounting_status='draft_not_posted'" +
      " AND EXISTS (SELECT 1 FROM " + ap +
      " parent_ap WHERE parent_ap.id=" + handoff + ".ap_preparation_id" +
      " AND parent_ap.company_id=" + handoff + ".company_id)" +
      " AND EXISTS (SELECT 1 FROM " + pr +
      " parent_pr WHERE parent_pr.id=" + handoff + ".payment_request_id" +
      " AND parent_pr.company_id=" + handoff + ".company_id" +
      " AND parent_pr.source_type='marketplace_ap' AND parent_pr.status='draft')",
};
const policies = [
  ["ci_fin_ap_insert", ap, "ap"],
  ["ci_fin_pr_insert", pr, "pr"],
  ["ci_fin_handoff_insert", handoff, "handoff"],
];
async function setChecks(checks) {
  for (const [name, table, key] of policies) {
    await pool.query("ALTER POLICY " + name + " ON " + table +
      " WITH CHECK (" + checks[key] + ")");
  }
}
async function attempt(sql, params) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE " + role);
    await client.query("SELECT set_config('app.marketplace_company_id','1',true)");
    try {
      await client.query(sql, params);
      return true;
    } catch (error) {
      if (error.code !== "42501") throw error;
      return false;
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
async function clean() {
  for (const table of [handoff, pr, ap, vi]) {
    await pool.query("DROP TABLE IF EXISTS " + table + " CASCADE");
  }
  await pool.query("DROP ROLE IF EXISTS " + role);
}
try {
  await pool.query("CREATE ROLE " + role + " NOLOGIN NOBYPASSRLS NOINHERIT");
  await pool.query("CREATE TABLE " + vi +
    " (id int PRIMARY KEY,company_id int NOT NULL,three_way_match_status text NOT NULL)");
  await pool.query("CREATE TABLE " + ap +
    " (id int PRIMARY KEY,company_id int NOT NULL,vendor_invoice_id int NOT NULL,status text NOT NULL)");
  await pool.query("CREATE TABLE " + pr +
    " (id int PRIMARY KEY,company_id int NOT NULL,mkt_ap_preparation_id int NOT NULL," +
    " status text NOT NULL,source_type text NOT NULL,journal_entry_id int)");
  await pool.query("CREATE TABLE " + handoff +
    " (id int PRIMARY KEY,company_id int NOT NULL,ap_preparation_id int NOT NULL," +
    " payment_request_id int NOT NULL,accounting_status text NOT NULL)");
  await pool.query("INSERT INTO " + vi + " VALUES (1,1,'passed'),(2,2,'passed')");
  await pool.query("INSERT INTO " + ap +
    " VALUES (10,1,1,'ap_preparation'),(20,2,2,'waiting_payment')");
  await pool.query("INSERT INTO " + pr +
    " VALUES (10,1,10,'draft','marketplace_ap',NULL),(20,2,20,'draft','marketplace_ap',NULL)");
  await pool.query("GRANT USAGE ON SCHEMA public TO " + role);
  await pool.query("GRANT SELECT ON " + [vi,ap,pr,handoff].join(",") + " TO " + role);
  await pool.query("GRANT INSERT ON " + [ap,pr,handoff].join(",") + " TO " + role);
  for (const table of [vi,ap,pr,handoff]) {
    await pool.query("ALTER TABLE " + table + " ENABLE ROW LEVEL SECURITY");
    // Broader referenced-row visibility intentionally exposes the implicit
    // dependency of old checks on unrelated SELECT policies.
    await pool.query("CREATE POLICY ci_fin_ref_read ON " + table +
      " FOR SELECT TO " + role + " USING (true)");
  }
  for (const [name, table, key] of policies) {
    await pool.query("CREATE POLICY " + name + " ON " + table +
      " FOR INSERT TO " + role + " WITH CHECK (" + checksOld[key] + ")");
  }

  assert.equal(await attempt("INSERT INTO " + ap + " VALUES ($1,$2,$3,$4)",
    [101,1,2,"ap_preparation"]),true,"old AP check fails to bind invoice company");
  assert.equal(await attempt("INSERT INTO " + pr + " VALUES ($1,$2,$3,$4,$5,$6)",
    [101,1,20,"draft","marketplace_ap",null]),true,"old payment check fails to bind AP company");
  assert.equal(await attempt("INSERT INTO " + handoff + " VALUES ($1,$2,$3,$4,$5)",
    [101,1,20,20,"draft_not_posted"]),true,"old handoff check fails to bind parent companies");
  assert.equal(await attempt("INSERT INTO " + ap + " VALUES ($1,$2,$3,$4)",
    [102,1,1,"waiting_payment"]),true,"old AP check allows final status at INSERT");
  console.log("OLD_CHECK_REPRODUCED: 4/4");

  await setChecks(checksFixed);
  assert.equal(await attempt("INSERT INTO " + ap + " VALUES ($1,$2,$3,$4)",
    [101,1,2,"ap_preparation"]),false);
  assert.equal(await attempt("INSERT INTO " + pr + " VALUES ($1,$2,$3,$4,$5,$6)",
    [101,1,20,"draft","marketplace_ap",null]),false);
  assert.equal(await attempt("INSERT INTO " + handoff + " VALUES ($1,$2,$3,$4,$5)",
    [101,1,20,20,"draft_not_posted"]),false);
  assert.equal(await attempt("INSERT INTO " + ap + " VALUES ($1,$2,$3,$4)",
    [102,1,1,"waiting_payment"]),false);
  console.log("CORRECTED_CHECK_DENIAL: 4/4");

  assert.equal(await attempt("INSERT INTO " + ap + " VALUES ($1,$2,$3,$4)",
    [103,1,1,"ap_preparation"]),true);
  assert.equal(await attempt("INSERT INTO " + pr + " VALUES ($1,$2,$3,$4,$5,$6)",
    [103,1,10,"draft","marketplace_ap",null]),true);
  assert.equal(await attempt("INSERT INTO " + handoff + " VALUES ($1,$2,$3,$4,$5)",
    [103,1,10,10,"draft_not_posted"]),true);
  console.log("CORRECTED_CHECK_VALID_FLOWS: 3/3");
} finally {
  try { await clean(); } finally { await pool.end(); }
}
