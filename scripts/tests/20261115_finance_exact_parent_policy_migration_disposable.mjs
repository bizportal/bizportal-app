import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

// All SQL fixtures are isolated to the ephemeral GitHub Actions PostgreSQL
// service. Refuse a real Supabase connection, local workstation or VPS.
const raw = process.env.FINANCE_RELATION_PG_E2E_URL;
if (!raw || process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("REFUSE_NON_DISPOSABLE_FINANCE_TEST");
}
const url = new URL(raw);
if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
    url.port !== "65432" || url.pathname !== "/payroll_ci" ||
    url.username !== "postgres.xssrfshdrtdfupgqwfdw") {
  throw new Error("REFUSE_REAL_SUPABASE_FINANCE_DATABASE");
}

const sql = readFileSync(
  new URL("../sql/20261115_finance_parent_company_rls_cst_dev.sql", import.meta.url), "utf8",
);
const role = "bizportal_marketplace_finance_login_dev";
const pool = new pg.Pool({ connectionString: raw, max: 2 });
const objects = ["mkt_accounting_handoffs", "payment_requests", "mkt_ap_preparations", "vendor_invoices"];

async function setup() {
  await pool.query(`CREATE ROLE ${role} LOGIN NOBYPASSRLS NOSUPERUSER`);
  await pool.query(`CREATE TYPE public.mkt_ap_preparation_status AS ENUM ('ap_preparation','finance_review','waiting_payment')`);
  await pool.query(`CREATE TYPE public.pay_req_status AS ENUM ('draft','approved')`);
  await pool.query(`CREATE TABLE public.vendor_invoices
    (id integer PRIMARY KEY,company_id integer,mkt_purchase_order_id integer,three_way_match_status text)`);
  await pool.query(`CREATE TABLE public.mkt_ap_preparations
    (id integer PRIMARY KEY,company_id integer,vendor_invoice_id integer,status public.mkt_ap_preparation_status)`);
  await pool.query(`CREATE TABLE public.payment_requests
    (id integer PRIMARY KEY,company_id integer,source_type text,status public.pay_req_status,
     mkt_ap_preparation_id integer,journal_entry_id integer)`);
  await pool.query(`CREATE TABLE public.mkt_accounting_handoffs
    (id integer PRIMARY KEY,company_id integer,accounting_status text,ap_preparation_id integer,
     payment_request_id integer)`);
  await pool.query(`INSERT INTO public.vendor_invoices VALUES (1,1,101,'passed'),(2,2,202,'passed')`);
  await pool.query(`INSERT INTO public.mkt_ap_preparations VALUES
    (10,1,1,'ap_preparation'),(20,2,2,'waiting_payment')`);
  await pool.query(`INSERT INTO public.payment_requests VALUES
    (10,1,'marketplace_ap','draft',10,NULL),(20,2,'marketplace_ap','draft',20,NULL)`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  for (const object of objects) {
    await pool.query(`GRANT SELECT ON public.${object} TO ${role}`);
    await pool.query(`ALTER TABLE public.${object} ENABLE ROW LEVEL SECURITY`);
    await pool.query(`CREATE POLICY ci_finance_read_all ON public.${object}
      FOR SELECT TO ${role} USING (true)`);
  }
  for (const object of objects.slice(0,3)) {
    await pool.query(`GRANT INSERT ON public.${object} TO ${role}`);
  }
  // Reproduce the actual prior policy expressions from CST-DEV. Independent
  // existing SELECT rules are deliberately broad so the old bug is exposed.
  await pool.query(`CREATE POLICY pr50_finance_dev_ap_insert ON public.mkt_ap_preparations
    FOR INSERT TO ${role} WITH CHECK (
      company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
      AND EXISTS (SELECT 1 FROM public.vendor_invoices vi
        WHERE vi.id=vendor_invoice_id AND vi.company_id=company_id
        AND vi.mkt_purchase_order_id IS NOT NULL AND vi.three_way_match_status='passed')
    )`);
  await pool.query(`CREATE POLICY pr50_finance_dev_payment_insert ON public.payment_requests
    FOR INSERT TO ${role} WITH CHECK (
      company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
      AND source_type='marketplace_ap' AND status='draft'
      AND mkt_ap_preparation_id IS NOT NULL AND journal_entry_id IS NULL
      AND EXISTS (SELECT 1 FROM public.mkt_ap_preparations ap
        WHERE ap.id=mkt_ap_preparation_id AND ap.company_id=company_id)
    )`);
  await pool.query(`CREATE POLICY pr50_finance_dev_handoff_insert ON public.mkt_accounting_handoffs
    FOR INSERT TO ${role} WITH CHECK (
      company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
      AND accounting_status='draft_not_posted'
      AND EXISTS (SELECT 1 FROM public.mkt_ap_preparations ap
        WHERE ap.id=ap_preparation_id AND ap.company_id=company_id)
      AND EXISTS (SELECT 1 FROM public.payment_requests pr
        WHERE pr.id=payment_request_id AND pr.company_id=company_id
        AND pr.source_type='marketplace_ap' AND pr.status='draft')
    )`);
}

async function attempt(statement,params) {
  const c=await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('app.marketplace_company_id','1',true)");
    try {
      await c.query(statement,params);
      return true;
    } catch (err) {
      if (err.code!=="42501") throw err;
      return false;
    }
  } finally {
    await c.query("ROLLBACK").catch(()=>undefined);
    c.release();
  }
}

async function exercise(expected) {
  const cases = [
    ["ap_wrong_company", "INSERT INTO public.mkt_ap_preparations VALUES($1,$2,$3,$4)", [101,1,2,"ap_preparation"]],
    ["payment_wrong_company", "INSERT INTO public.payment_requests VALUES($1,$2,$3,$4,$5,$6)", [101,1,"marketplace_ap","draft",20,null]],
    ["handoff_wrong_company", "INSERT INTO public.mkt_accounting_handoffs VALUES($1,$2,$3,$4,$5)", [101,1,"draft_not_posted",20,20]],
    ["ap_wrong_initial_status", "INSERT INTO public.mkt_ap_preparations VALUES($1,$2,$3,$4)", [102,1,1,"waiting_payment"]],
    ["ap_valid", "INSERT INTO public.mkt_ap_preparations VALUES($1,$2,$3,$4)", [103,1,1,"ap_preparation"]],
    ["payment_valid", "INSERT INTO public.payment_requests VALUES($1,$2,$3,$4,$5,$6)", [103,1,"marketplace_ap","draft",10,null]],
    ["handoff_valid", "INSERT INTO public.mkt_accounting_handoffs VALUES($1,$2,$3,$4,$5)", [103,1,"draft_not_posted",10,10]],
  ];
  for (let index=0;index<cases.length;index++) {
    const [name,statement,params]=cases[index];
    assert.equal(await attempt(statement,params),expected[index],name);
  }
}

async function cleanup(){
  for(const table of objects){await pool.query(`DROP TABLE IF EXISTS public.${table} CASCADE`)}
  await pool.query('DROP TYPE IF EXISTS public.mkt_ap_preparation_status');
  await pool.query('DROP TYPE IF EXISTS public.pay_req_status');
  await pool.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
  await pool.query(`DROP ROLE IF EXISTS ${role}`);
}

try {
  await setup();
  // Prior policy permitted cross-company parent references and final AP status.
  await exercise([true,true,true,true,true,true,true]);
  console.log("EXACT_MIGRATION_PRIOR_POLICY_BUG_REPRODUCED=4/4");
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
    } catch(e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {client.release()}
  await exercise([false,false,false,false,true,true,true]);
  console.log("EXACT_MIGRATION_BLOCKED_INVALID=4/4");
  console.log("EXACT_MIGRATION_RETAINED_VALID=3/3");
  const policies=await pool.query(`SELECT policyname,with_check FROM pg_policies WHERE schemaname='public' AND
    policyname IN ('pr50_finance_dev_ap_insert','pr50_finance_dev_payment_insert','pr50_finance_dev_handoff_insert')`);
  assert.equal(policies.rowCount,3);
  for(const p of policies.rows){
    assert.ok(p.with_check.includes("app.marketplace_company_id"));
    assert.doesNotMatch(p.with_check,/(vi|ap|pr)\.company_id\s*=\s*\1\.company_id/);
  }
  console.log("EXACT_MIGRATION_POSTGRES_POLICY_ATTENTION=PASS");
} finally {
  try{await cleanup()}finally{await pool.end()}
}
