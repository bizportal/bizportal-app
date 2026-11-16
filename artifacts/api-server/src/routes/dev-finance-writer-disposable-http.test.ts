import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { hash } from "bcryptjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Full signed HTTP → canonical AP services → real disposable PostgreSQL.
// The test ONLY substitutes the finance TLS adapter because production code
// correctly refuses localhost/unpinned Supabase credentials. No live secrets.
const RAW = process.env.FINANCE_RELATION_PG_E2E_URL;
const enabled = Boolean(RAW && process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true");
const AUTH_ROLE = "bizportal_pr81_otp_login_dev";
const FIN_ROLE = "bizportal_marketplace_finance_login_dev";
const EMAIL = "admcst001@gmail.com";
const PASSWORD = "ci-disposable-password-only";
const testPools = vi.hoisted(() => ({ auth: null as any, finance: null as any }));
function disposableUrl(): URL {
  if (!enabled || !RAW) throw new Error("REFUSE_NON_DISPOSABLE_FINANCE_HTTP");
  const u = new URL(RAW);
  if (u.protocol !== "postgresql:" || u.hostname !== "127.0.0.1" ||
      u.port !== "65432" || u.pathname !== "/payroll_ci" ||
      u.username !== "postgres.xssrfshdrtdfupgqwfdw")
    throw new Error("REFUSE_WRONG_FINANCE_HTTP_DB");
  return u;
}
vi.mock("@workspace/db", async (originalFactory) => {
  const actual = await originalFactory<typeof import("@workspace/db")>();
  if (!process.env.FINANCE_RELATION_PG_E2E_URL ||
      process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") return actual;
  const u = new URL(process.env.FINANCE_RELATION_PG_E2E_URL);
  if (u.hostname !== "127.0.0.1" || u.port !== "65432" ||
      u.pathname !== "/payroll_ci" || u.username !== "postgres.xssrfshdrtdfupgqwfdw")
    throw new Error("REFUSE_TEST_FINANCE_DB_OVERRIDE");
  const driver = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { sql } = await import("drizzle-orm");
  const common = { host: "127.0.0.1", port: 65432, database: "payroll_ci",
    max: 3, connectionTimeoutMillis: 5000 };
  const auth = new driver.Pool({ ...common, user: AUTH_ROLE, password: "ci-auth-local-only" });
  const finance = new driver.Pool({ ...common, user: FIN_ROLE, password: "ci-finance-local-only" });
  testPools.auth = auth; testPools.finance = finance;
  const financeDb = drizzle(finance, { schema: actual });
  async function withCompany<T>(id: number, work: (db: typeof financeDb) => Promise<T>, readOnly = false) {
    if (process.env.APP_ENV !== "development" ||
        (!readOnly && process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true"))
      throw new Error("DEV_FINANCE_WRITER_DISABLED");
    if (![1,3].includes(id)) throw new Error("UNAPPROVED_COMPANY");
    return financeDb.transaction(async (tx) => {
      if (readOnly) await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
      const role = await tx.execute(sql.raw("SELECT current_user::text AS role, row_security_active('public.mkt_ap_preparations'::regclass) AS rls_active"));
      if (role.rows[0]?.role !== FIN_ROLE || role.rows[0]?.rls_active !== true)
        throw new Error("FINANCE_CI_ROLE_OR_RLS_INVALID");
      await tx.execute(sql.raw("SELECT set_config('app.marketplace_company_id','" + id + "',true)"));
      return work(tx as unknown as typeof financeDb);
    });
  }
  return { ...actual, db: financeDb, pool: auth,
    withMarketplaceFinanceDevTransaction: <T>(id: number, fn: (db: typeof financeDb) => Promise<T>) => withCompany(id, fn),
    withMarketplaceFinanceDevReadOnlyTransaction: <T>(id: number, fn: (db: typeof financeDb) => Promise<T>) => withCompany(id, fn, true),
    onMarketplaceFinanceCommit: (_tx: object, _notify: () => unknown) => undefined,
  };
});
import * as schema from "@workspace/db";
import authRouter from "./local-production-auth";
import financeRouter from "./dev-marketplace-finance-writer";
const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const tables = [schema.mktPurchaseOrdersTable, schema.mktPoShipmentsTable,
  schema.mktPoGoodsReceiptsTable, schema.vendorInvoicesTable,
  schema.vendorInvoiceLinesTable, schema.mktApPreparationsTable,
  schema.paymentRequestsTable, schema.mktAccountingHandoffsTable];
function typeFor(raw: string) {
  if (["mkt_po_status","vi_status","mkt_ap_preparation_status","pay_req_status"].includes(raw)) return "text";
  if (/^(serial|integer|numeric|text|timestamp|date|boolean|jsonb|varchar|uuid|double precision)/i.test(raw)) return raw;
  throw new Error("DISPOSABLE_COLUMN_TYPE_UNKNOWN:" + raw);
}
describe.skipIf(!enabled)("PR81 signed HTTP Finance Writer over disposable PostgreSQL", () => {
  let root: pg.Client; let connected = false; let server: Server | undefined;
  let origin = ""; let session = ""; let scope1 = ""; let apId = 0;
  beforeAll(async () => {
    disposableUrl();
    Object.assign(process.env, {
      APP_ENV: "development", NODE_ENV: "production",
      SESSION_SECRET: "ci-finance-local-session-secret-for-tests-only-2026",
      BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV: "true",
      BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_ID_DEV: "ci-finance-admin",
      BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV: EMAIL,
      BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV: "true",
      BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV: "true",
      BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV: "true",
      BIZPORTAL_FINANCE_GLOBAL_SUPERADMIN_EMAILS_DEV: EMAIL,
      BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV: "1,3",
    });
    delete process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV;
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV;
    root = new pg.Client({ connectionString: RAW, connectionTimeoutMillis: 5000 });
    await root.connect(); connected = true;
    const identity = await root.query("SELECT current_database() AS db,current_user AS role");
    expect(identity.rows[0]).toEqual({ db:"payroll_ci", role:"postgres.xssrfshdrtdfupgqwfdw" });
    for (const role of [AUTH_ROLE, FIN_ROLE]) {
      if ((await root.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount)
        throw new Error("DISPOSABLE_DB_NOT_EMPTY");
    }
    await root.query("CREATE ROLE " + AUTH_ROLE + " LOGIN NOINHERIT NOBYPASSRLS PASSWORD 'ci-auth-local-only'");
    await root.query("CREATE ROLE " + FIN_ROLE + " LOGIN NOINHERIT NOBYPASSRLS PASSWORD 'ci-finance-local-only'");
    await root.query("CREATE TABLE public.companies(id integer PRIMARY KEY,is_active boolean NOT NULL DEFAULT true)");
    await root.query("CREATE TABLE public.users(id text PRIMARY KEY,email text,password_hash text,role text,status text,is_active boolean,company_id integer)");
    await root.query("CREATE TABLE public.audit_logs(user_email text,action text NOT NULL,entity_type text,entity_id text,after_data jsonb,company_id text,module text,ip_address text)");
    for (const t of tables) {
      const info = getTableConfig(t);
      const columns = info.columns.map(c => quote(c.name) + " " + typeFor(c.getSQLType()) +
        (c.name === "id" ? " PRIMARY KEY" : "") +
        (["created_at","updated_at"].includes(c.name) ? " DEFAULT now()" : ""));
      await root.query("CREATE TABLE public." + quote(info.name) + "(" + columns.join(",") + ")");
    }
    for (const index of [
      "CREATE UNIQUE INDEX ci_ap_invoice ON public.mkt_ap_preparations(vendor_invoice_id)",
      "CREATE UNIQUE INDEX ci_pr_ap ON public.payment_requests(mkt_ap_preparation_id)",
      "CREATE UNIQUE INDEX ci_pr_key ON public.payment_requests(idempotency_key)",
      "CREATE UNIQUE INDEX ci_handoff_ap ON public.mkt_accounting_handoffs(ap_preparation_id)",
      "CREATE UNIQUE INDEX ci_handoff_key ON public.mkt_accounting_handoffs(handoff_key)",
    ]) await root.query(index);
    await root.query("GRANT USAGE ON SCHEMA public TO " + AUTH_ROLE + "," + FIN_ROLE);
    await root.query("GRANT SELECT ON public.users,public.companies TO " + AUTH_ROLE);
    await root.query("GRANT INSERT ON public.audit_logs TO " + AUTH_ROLE);
    await root.query("ALTER TABLE public.users ENABLE ROW LEVEL SECURITY");
    await root.query("ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY");
    await root.query("CREATE POLICY ci_user_read ON public.users FOR SELECT TO " + AUTH_ROLE +
      " USING (email='admcst001@gmail.com' AND is_active AND status='active')");
    await root.query("CREATE POLICY pr81_auth_delivery_audit_insert ON public.audit_logs FOR INSERT TO " +
      AUTH_ROLE + " WITH CHECK (lower(btrim(user_email))='admcst001@gmail.com' AND action='email_otp_delivery_failed' AND entity_type='auth' AND company_id='default' AND module='system')");
    const auditSql = readFileSync(resolve(process.cwd(),
      "../../scripts/sql/20261116_pr81_finance_scope_audit_insert_STAGED.sql"), "utf8");
    if (!auditSql.includes("PR81_FINANCE_AUDIT_POLICY_PRECONDITION_FAILED") ||
        !auditSql.trimEnd().endsWith("COMMIT;")) throw new Error("UNVERIFIED_AUDIT_SOURCE");
    await root.query(auditSql);
    for (const t of tables) {
      const name = getTableConfig(t).name;
      await root.query("ALTER TABLE public." + quote(name) + " ENABLE ROW LEVEL SECURITY");
      await root.query("GRANT SELECT ON public." + quote(name) + " TO " + FIN_ROLE);
    }
    await root.query("GRANT INSERT,UPDATE ON public.mkt_ap_preparations TO " + FIN_ROLE);
    await root.query("GRANT INSERT ON public.payment_requests,public.mkt_accounting_handoffs TO " + FIN_ROLE);
    await root.query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO " + FIN_ROLE);
    const scope = "nullif(current_setting('app.marketplace_company_id',true),'')::integer";
    for (const name of ["mkt_purchase_orders","vendor_invoices","mkt_ap_preparations","payment_requests","mkt_accounting_handoffs"])
      await root.query("CREATE POLICY ci_select ON public." + name +
        " FOR SELECT TO " + FIN_ROLE + " USING (company_id=" + scope + ")");
    for (const name of ["mkt_po_shipments","mkt_po_goods_receipts","vendor_invoice_lines"])
      await root.query("CREATE POLICY ci_select ON public." + name +
        " FOR SELECT TO " + FIN_ROLE + " USING (true)");
    await root.query("CREATE POLICY ci_ap_insert ON public.mkt_ap_preparations FOR INSERT TO " + FIN_ROLE +
      " WITH CHECK (company_id=" + scope + " AND status='ap_preparation')");
    await root.query("CREATE POLICY ci_ap_update ON public.mkt_ap_preparations FOR UPDATE TO " + FIN_ROLE +
      " USING (company_id=" + scope + ") WITH CHECK (company_id=" + scope + ")");
    await root.query("CREATE POLICY ci_pr_insert ON public.payment_requests FOR INSERT TO " + FIN_ROLE +
      " WITH CHECK (company_id=" + scope + " AND status='draft' AND source_type='marketplace_ap' AND journal_entry_id IS NULL)");
    await root.query("CREATE POLICY ci_handoff_insert ON public.mkt_accounting_handoffs FOR INSERT TO " + FIN_ROLE +
      " WITH CHECK (company_id=" + scope + " AND accounting_status='draft_not_posted')");
    await root.query("INSERT INTO public.companies VALUES(1,true),(3,true)");
    await root.query("INSERT INTO public.users VALUES($1,$2,$3,'super_admin','active',true,NULL)",
      ["ci-finance-admin", EMAIL, await hash(PASSWORD, 4)]);
    await root.query("INSERT INTO public.mkt_purchase_orders(id,po_number,rfq_id,quote_id,company_id,vendor_id,status,total_amount,tax_amount,grand_total) VALUES(101,'CI-PO-101',201,301,1,10,'confirmed',100,0,100)");
    await root.query("INSERT INTO public.mkt_po_shipments(id,po_id,shipment_number,shipment_status) VALUES(102,101,'CI-SHIP-102','delivered')");
    await root.query("INSERT INTO public.mkt_po_goods_receipts(id,shipment_id,receipt_number,receipt_type,inspection_status) VALUES(103,102,'CI-GR-103','full','passed')");
    await root.query("INSERT INTO public.vendor_invoices(id,invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,mkt_purchase_order_id,mkt_goods_receipt_id,status,three_way_match_status,currency,total_amount,tax_amount,grand_total,invoice_date) VALUES(104,'CI-VI-104','CI-REF-104',1,10,'CI Synthetic Vendor',101,103,'ready_for_ap','passed','IDR',100,0,100,now())");
    const app = express();
    app.use(express.json());
    app.use((req,_res,next) => { (req as any).log = {
      error: () => undefined, warn: () => undefined, info: () => undefined,
    }; next(); });
    app.use("/api",authRouter); app.use("/api",financeRouter);
    server = app.listen(0,"127.0.0.1");
    await new Promise<void>(ok => server!.once("listening",ok));
    origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  },30000);
  afterAll(async () => {
    if (server) await new Promise<void>(ok => server!.close(() => ok()));
    await testPools.auth?.end(); await testPools.finance?.end();
    if (connected) {
      for (const t of [...tables].reverse())
        await root.query("DROP TABLE IF EXISTS public." + quote(getTableConfig(t).name) + " CASCADE").catch(() => {});
      for (const t of ["audit_logs","users","companies"])
        await root.query("DROP TABLE IF EXISTS public." + t + " CASCADE").catch(() => {});
      for (const role of [FIN_ROLE,AUTH_ROLE]) {
        await root.query("REVOKE USAGE ON SCHEMA public FROM " + role).catch(() => {});
        await root.query("DROP ROLE IF EXISTS " + role).catch(() => {});
      }
      await root.end();
    }
  },30000);
  function post(path: string, cookie = session + "; " + scope1, body: object = {}) {
    return fetch(origin + path, {method:"POST",headers:{
      "Content-Type":"application/json",Cookie:cookie,Origin:origin,"Sec-Fetch-Site":"same-origin",
    },body:JSON.stringify(body)});
  }
  it("authenticates with existing signed password and audits company scope in real PG",async () => {
    const login = await fetch(origin + "/api/auth/email-login",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({email:EMAIL,password:PASSWORD})});
    expect(login.status).toBe(200);
    session=(login.headers.get("set-cookie")||"").split(";")[0];
    expect(session).toContain("bizportal_supabase_session=");
    const select = await post("/api/mkt/admin/finance-company-selection",session,{companyId:1});
    expect(select.status).toBe(200);
    scope1=(select.headers.get("set-cookie")||"").split(";")[0];
    expect(scope1).toContain("bizportal_finance_company_scope=");
    const a=await root.query("SELECT company_id FROM public.audit_logs WHERE action='finance_company_scope_selected'");
    expect(a.rows).toEqual([{company_id:"1"}]);
  });
  let apId=0;
  it("creates/reuses canonical AP and advances to waiting_payment over HTTP",async () => {
    const first=await post("/api/mkt/admin/vendor-invoices/104/ap-preparation");
    expect(first.status).toBe(201);
    apId=(await first.json() as any).data.id;
    expect(apId).toBeGreaterThan(0);
    const repeated=await post("/api/mkt/admin/vendor-invoices/104/ap-preparation");
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as any).data.id).toBe(apId);
    for (const action of ["finance-review","waiting-payment"]) {
      const result=await post("/api/mkt/admin/ap-preparations/"+apId+"/"+action);
      expect(result.status).toBe(200);
      const replay=await post("/api/mkt/admin/ap-preparations/"+apId+"/"+action);
      expect(replay.status).toBe(200);
      expect((await replay.json() as any).alreadyProcessed).toBe(true);
    }
    const ap=await root.query("SELECT status FROM public.mkt_ap_preparations");
    expect(ap.rows).toEqual([{status:"waiting_payment"}]);
  });
  it("creates one Accounting Draft and replay returns same payment/handoff IDs without GL",async () => {
    const route="/api/mkt/admin/ap-preparations/"+apId+"/accounting-handoff";
    const first=await post(route);
    expect(first.status).toBe(201);
    const record=await first.json() as any;
    expect(record).toMatchObject({ok:true,alreadyExists:false,paymentStatus:"draft",journalPosted:false});
    const replay=await post(route);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({alreadyExists:true,
      paymentRequestId:record.paymentRequestId,handoffId:record.handoffId});
    const p=await root.query("SELECT status,paid_amount,journal_entry_id FROM public.payment_requests");
    expect(p.rows).toEqual([{status:"draft",paid_amount:"0.00",journal_entry_id:null}]);
    const h=await root.query("SELECT accounting_status,payment_request_id FROM public.mkt_accounting_handoffs");
    expect(h.rows).toEqual([{accounting_status:"draft_not_posted",payment_request_id:record.paymentRequestId}]);
  });
  it("denies cross-company signed scope without creating extra financial rows",async () => {
    const select=await post("/api/mkt/admin/finance-company-selection",session,{companyId:3});
    expect(select.status).toBe(200);
    const scope3=(select.headers.get("set-cookie")||"").split(";")[0];
    expect((await post("/api/mkt/admin/ap-preparations/"+apId+"/accounting-handoff",session+"; "+scope3)).status).toBe(404);
    const read=await fetch(origin+"/api/mkt/admin/ap-preparations/"+apId,{headers:{Cookie:session+"; "+scope3}});
    expect(read.status).toBe(404);
    expect((await root.query("SELECT count(*)::int n FROM public.payment_requests")).rows[0].n).toBe(1);
    expect((await root.query("SELECT count(*)::int n FROM public.mkt_accounting_handoffs")).rows[0].n).toBe(1);
  });
});
