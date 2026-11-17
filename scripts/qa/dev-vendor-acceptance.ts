/**
 * Reviewed CST-DEV acceptance, distinct from disposable CI.
 * --check is read-only; --execute requires the explicit execution flag.
 * Run only on the verified srv1792369 staging host after reviewing this file.
 * Uses actual GCP company sessions, vendor HTTPS upload/submit, canonical AP
 * services and real audit callbacks. It never fabricates a signed admin login.
 * Credentials and capability tokens stay in memory and never enter reports.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { rootCertificates } from "node:tls";
import { SUPABASE_FINANCE_ROOT_2021_PEM } from "../../lib/db/src/supabase-finance-root-2021";
import type { PoolClient } from "pg";

const PROJECT = "xssrfshdrtdfupgqwfdw";
const ORIGIN = "https://finance-pr81.72.61.210.205.sslip.io";
const PREVIEW_UNIT = "cst-bizportal-pr81-preview.service";
const ADMIN_UNIT = "cst-bizportal-gmail-dev.service";
const COMPANY_IDS = [1, 3] as const;
const PARENT_TABLES = ["suppliers", "mkt_rfqs", "mkt_vendor_quotes", "mkt_purchase_orders",
  "mkt_purchase_order_lines", "mkt_po_shipments", "mkt_po_shipment_items",
  "mkt_po_goods_receipts", "mkt_po_goods_receipt_items", "vendor_invoices",
  "vendor_invoice_lines", "mkt_ap_preparations", "mkt_accounting_handoffs", "payment_requests"];
const FLAGS = ["BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_VENDOR_INVOICE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_SINGLE_GCP_SECRET_DEV",
  "BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV",
  "BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV", "ALLOW_DEV_STORAGE_WRITES"];
const mode = process.argv[2];
const marker = `QA-DEV-INVACCEPT-${Date.now()}-${randomBytes(4).toString("hex")}`;
let stage = "arguments";
let publicCertificateDirectory: string | undefined;
let seeded = false;
let baselinePo14: unknown;
let app: typeof import("../../lib/db/src/index") | undefined;
let admin: PoolClient | undefined;
type Fixture = { companyId: 1 | 3; supplierId: number; rfqId: number; quoteId: number;
  poId: number; lineIds: number[]; shipmentId: number; grId: number;
  token: string; reference: string; invoiceId?: number; apId?: number;
  paymentRequestId?: number; handoffId?: number; objectPath?: string };
const fixtures: Fixture[] = [];
const checks: string[] = [];
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`QA_${code}`);
}
function passed(code: string, data?: Record<string, unknown>) {
  checks.push(code); console.log(JSON.stringify({ check: code, result: "PASS", ...data }));
}
function serviceEnvironment(unit: string) {
  const pid = Number(execFileSync("systemctl", ["show", "--property=MainPID", "--value", unit],
    { encoding: "utf8", timeout: 5_000 }).trim());
  requireThat(Number.isSafeInteger(pid) && pid > 1, "SERVICE_NOT_RUNNING");
  const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return { pid, env };
}
function configureFromVerifiedServices() {
  const preview = serviceEnvironment(PREVIEW_UNIT);
  const legacy = serviceEnvironment(ADMIN_UNIT);
  requireThat(preview.env.APP_ENV === "development" && legacy.env.APP_ENV === "development", "LIVE_ENVIRONMENT");
  for (const flag of FLAGS) requireThat(preview.env[flag] === "true", `RUNTIME_FLAG_${flag}`);
  // A flag in an old runtime is insufficient evidence that HTTP notifications
  // are suppressed. Confirm the actual running bundle contains the reviewed gate.
  const args = readFileSync(`/proc/${preview.pid}/cmdline`, "utf8").split("\0");
  const entry = args.find((arg, i) => i > 0 && /\.(?:mjs|js)$/.test(arg));
  requireThat(entry, "PREVIEW_BUNDLE_UNRESOLVED");
  const bundle = readFileSync(isAbsolute(entry) ? entry : resolve(readlinkSync(`/proc/${preview.pid}/cwd`), entry), "utf8");
  requireThat(bundle.includes("BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV") &&
    bundle.includes("mkt_vendor_invoice_uploaded"), "PREVIEW_NOTIFICATION_GATE_MISSING");
  requireThat(preview.env.SUPABASE_URL_DEV?.replace(/\/+$/, "") === `https://${PROJECT}.supabase.co` &&
    preview.env.SUPABASE_SERVICE_ROLE_KEY_DEV, "STORAGE_DEV_IDENTITY");
  const raw = legacy.env.SUPABASE_DATABASE_URL_DEV;
  requireThat(raw, "VERIFIED_ADMIN_DSN_MISSING");
  const source = new URL(raw);
  const user = decodeURIComponent(source.username);
  const direct = source.hostname === `db.${PROJECT}.supabase.co`;
  requireThat(["postgres:", "postgresql:"].includes(source.protocol) &&
    (direct || source.hostname.endsWith(".pooler.supabase.com")) &&
    (user === `postgres.${PROJECT}` || (direct && user === "postgres")) &&
    source.pathname === "/postgres" && source.password &&
    ["", "5432", "6543"].includes(source.port), "ADMIN_PROJECT_OR_ROLE");
  // Reconstruct the URL from validated authority fields. No unvalidated query
  // option can override host/user/password or weaken TLS in pg's URL parser.
  source.search = ""; source.hash = "";
  source.searchParams.set("sslmode", "verify-full");
  publicCertificateDirectory = mkdtempSync(join(tmpdir(), "bizportal-qa-public-ca-"));
  const publicCa = join(publicCertificateDirectory, "supabase-roots.pem");
  // The verified DEV pooler also presents the Supabase chain. Retain system
  // roots plus the pinned public root for either host, always verify-full.
  writeFileSync(publicCa, [...rootCertificates, SUPABASE_FINANCE_ROOT_2021_PEM].join("\n"), { mode: 0o600 });
  source.searchParams.set("sslrootcert", publicCa);
  process.env.APP_ENV = "development";
  process.env.NODE_ENV = "production";
  process.env.LOG_LEVEL = "silent";
  // One retained setup/cleanup connection and one real post-commit audit
  // connection; never inherit the OTP runtime's single-connection pool size.
  process.env.DB_POOL_MAX = "2";
  process.env.SUPABASE_DATABASE_URL_DEV = source.toString();
  delete process.env.SUPABASE_DATABASE_URL;
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_DATABASE_URL_DEV;
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_GCP_SECRET_NAME_DEV;
  delete process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON;
  process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED = "true";
  process.env.CREDENTIALS_DIRECTORY = `/run/credentials/${PREVIEW_UNIT}`;
  for (const flag of FLAGS) process.env[flag] = preview.env[flag];
  process.env.SUPABASE_URL_DEV = preview.env.SUPABASE_URL_DEV;
  process.env.SUPABASE_SERVICE_ROLE_KEY_DEV = preview.env.SUPABASE_SERVICE_ROLE_KEY_DEV;
}
async function po14Fingerprint() {
  return (await admin!.query(`select jsonb_build_object(
    'po',(select md5(row_to_json(p)::text) from public.mkt_purchase_orders p where id=14),
    'invoices',(select count(*) from public.vendor_invoices where mkt_purchase_order_id=14),
    'ap',(select count(*) from public.mkt_ap_preparations where mkt_purchase_order_id=14),
    'handoffs',(select count(*) from public.mkt_accounting_handoffs where mkt_purchase_order_id=14)) as state`)).rows[0].state;
}
async function preflight() {
  stage = "runtime_preflight"; configureFromVerifiedServices();
  app = await import("../../lib/db/src/index");
  admin = await app.pool.connect();
  const identity = (await admin.query(`select current_user::text usr,session_user::text login,
    current_database() db,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) tls`)).rows[0];
  requireThat(identity.usr === "postgres" && identity.login === "postgres" &&
    identity.db === "postgres" && identity.tls === true, "ADMIN_SESSION_IDENTITY_OR_TLS");
  const lock = (await admin.query(`select md5(prosrc) fingerprint,prosecdef from pg_proc
    where oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)')`)).rows[0];
  requireThat(lock?.fingerprint === "06d261a1ec4908c31b681d7a0f1f26cd" && lock.prosecdef === true, "LOCK_FUNCTION_DRIFT");
  const triggers = await admin.query(`select count(*)::int n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal and c.relname=any($1::text[])`, [PARENT_TABLES]);
  requireThat(triggers.rows[0].n === 0, "NEW_PARENT_OR_FINANCE_TRIGGER_REQUIRES_REVIEW");
  const bucket = (await admin.query("select public from storage.buckets where id='private-uploads'")).rows[0];
  requireThat(bucket?.public === false, "PRIVATE_STORAGE_BUCKET");
  baselinePo14 = await po14Fingerprint();
  const baseline = baselinePo14 as { invoices: number; ap: number; handoffs: number };
  requireThat(baseline.invoices === 0 && baseline.ap === 0 && baseline.handoffs === 0, "PO14_BASELINE_NOT_ZERO");
  const { sql } = await import("drizzle-orm");
  for (const companyId of COMPANY_IDS) {
    await app.withMarketplaceFinanceDevReadOnlyTransaction(companyId, async tx => {
      const expected = companyId === 1 ? "bizportal_finance_cst_login_dev" : "bizportal_finance_diva_login_dev";
      const result = await tx.execute(sql`select current_user::text usr,session_user::text login,
        has_table_privilege(current_user,'public.accounting_entries','INSERT') gl_write,
        has_table_privilege(current_user,'public.payments','INSERT') payment_write`);
      requireThat(result.rows[0]?.usr === expected && result.rows[0]?.login === expected &&
        result.rows[0]?.gl_write === false && result.rows[0]?.payment_write === false, "COMPANY_AUTHORITY");
    });
  }
  passed("DEV_RUNTIME_GCP_TLS_COMPANY_ROLES_AND_NOTIFICATION_GATES");
}
async function insertId(text: string, values: unknown[]) {
  const id = Number((await admin!.query(text, values)).rows[0]?.id);
  requireThat(Number.isSafeInteger(id) && id > 0, "FIXTURE_INSERT_ID"); return id;
}
async function seed() {
  stage = "synthetic_parent_setup";
  await admin!.query("BEGIN");
  try {
    await admin!.query("SET LOCAL lock_timeout='3s'");
    for (const companyId of COMPANY_IDS) {
      const label = `${marker}-${companyId}`;
      const supplierId = await insertId(`insert into public.suppliers(name,company_id,status,is_active,note)
        values($1,$2,'active',true,$3) returning id`, [label, companyId, "Synthetic DEV invoice acceptance; no delivery/payment/contact"]);
      const rfqId = await insertId(`insert into public.mkt_rfqs(rfq_number,company_id,buyer_name,buyer_email,status,notes)
        values($1,$2,$1,'qa-vendor-acceptance@example.invalid','draft',$3) returning id`, [label, companyId, marker]);
      const quoteId = await insertId(`insert into public.mkt_vendor_quotes(rfq_id,vendor_id,token,status,notes)
        values($1,$2,$3,'selected',$4) returning id`, [rfqId, supplierId, randomBytes(32).toString("hex"), marker]);
      const token = randomBytes(32).toString("hex");
      const poId = await insertId(`insert into public.mkt_purchase_orders
        (po_number,rfq_id,quote_id,company_id,vendor_id,status,total_amount,tax_amount,grand_total,
         vendor_name_snapshot,currency_snapshot,vendor_token,vendor_token_expires_at,created_by)
        values($1,$2,$3,$4,$5,'delivered',200,0,200,$1,'IDR',$6,
          (clock_timestamp() at time zone 'UTC')+interval '20 minutes',$7) returning id`,
      [label, rfqId, quoteId, companyId, supplierId, token, marker]);
      requireThat(poId !== 14, "PROTECTED_PO_ID");
      const lineIds = [];
      for (const [name, qty, price] of [["QA item one", 1, 100], ["QA item two", 2, 50]] as const) {
        lineIds.push(await insertId(`insert into public.mkt_purchase_order_lines
          (po_id,item_name,qty,unit_price,subtotal,unit) values($1,$2,$3,$4,100,'KG') returning id`, [poId, name, qty, price]));
      }
      const shipmentId = await insertId(`insert into public.mkt_po_shipments
        (po_id,shipment_number,shipment_status,notes,created_by) values($1,$2,'delivered',$3,$3) returning id`, [poId, label, marker]);
      const shipmentItemIds = [];
      for (let i = 0; i < lineIds.length; i++) shipmentItemIds.push(await insertId(`insert into public.mkt_po_shipment_items
        (shipment_id,po_line_id,line_number,qty) values($1,$2,$3,$3) returning id`, [shipmentId, lineIds[i], i + 1]));
      const grId = await insertId(`insert into public.mkt_po_goods_receipts
        (shipment_id,receipt_number,receipt_type,inspection_status,received_by,received_at,notes)
        values($1,$2,'full','passed',$3,clock_timestamp(),$3) returning id`, [shipmentId, label, marker]);
      for (let i = 0; i < shipmentItemIds.length; i++) await admin!.query(`insert into public.mkt_po_goods_receipt_items
        (goods_receipt_id,shipment_item_id,received_qty,accepted_qty,rejected_qty,condition)
        values($1,$2,$3,$3,0,'GOOD')`, [grId, shipmentItemIds[i], i + 1]);
      fixtures.push({ companyId, supplierId, rfqId, quoteId, poId, lineIds, shipmentId, grId, token, reference: label });
    }
    await admin!.query("COMMIT"); seeded = true;
  } catch (error) { await admin!.query("ROLLBACK"); throw error; }
  // Identifiers let the operator recover cleanup after process interruption.
  // No vendor capability, database URL or storage credential is logged.
  passed("SYNTHETIC_PARENTS_COMMITTED", { marker, fixtures: fixtures.map(({ token, ...f }) => f) });
}
function invoicePdf(reference: string): Buffer {
  const stream = `BT /F1 12 Tf 50 750 Td (SYNTHETIC DEV QA - NOT PAYABLE) Tj 0 -24 Td (${reference}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let data = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(data);
}
async function vendorRequest(f: Fixture, suffix: string, init?: RequestInit) {
  // Redirects are refused so a capability can never be forwarded to another host.
  const response = await fetch(`${ORIGIN}/api/mkt/vendor-invoice/${f.token}${suffix}`,
    { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  let body: any; try { body = await response.json(); } catch { throw new Error("QA_VENDOR_RESPONSE_NOT_JSON"); }
  requireThat(response.ok && body?.ok === true, `VENDOR_HTTP_${response.status}`);
  return { status: response.status, body };
}
async function upload(f: Fixture) {
  const form = new FormData();
  const values = { grId: String(f.grId), vendorInvoiceRef: f.reference,
    invoiceDate: new Date().toISOString().slice(0, 10), currency: "IDR",
    totalAmount: "200", taxAmount: "0", grandTotal: "200", notes: marker,
    lines: JSON.stringify(f.lineIds.map((poLineId, i) => ({ poLineId, quantity: i + 1,
      unitPrice: i === 0 ? 100 : 50, subtotal: 100, taxAmount: 0, name: "Synthetic DEV QA", unit: "KG" }))) };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  form.set("file", new Blob([new Uint8Array(invoicePdf(f.reference))], { type: "application/pdf" }), `${f.reference}.pdf`);
  return vendorRequest(f, "", { method: "POST", body: form });
}
async function exercise(f: Fixture) {
  stage = `company_${f.companyId}_vendor_https`;
  const created = await upload(f);
  requireThat(created.status === 201 && created.body.alreadyExists === false, "VENDOR_CREATE");
  f.invoiceId = Number(created.body.data?.id);
  requireThat(Number.isSafeInteger(f.invoiceId) && f.invoiceId! > 0 &&
    created.body.data?.mktPurchaseOrderId === f.poId && created.body.data?.supplierId === f.supplierId &&
    created.body.data?.status === "draft" && created.body.data?.lines?.length === 2, "VENDOR_CREATE_SHAPE");
  const replay = await upload(f);
  requireThat(replay.status === 200 && replay.body.alreadyExists === true && replay.body.data?.id === f.invoiceId, "VENDOR_UPLOAD_REPLAY");
  const submitted = await vendorRequest(f, `/invoices/${f.invoiceId}/submit`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  requireThat(submitted.body.data?.status === "ready_for_ap" && submitted.body.match?.status === "passed", "VENDOR_THREE_WAY_MATCH");
  const submittedAgain = await vendorRequest(f, `/invoices/${f.invoiceId}/submit`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  requireThat(submittedAgain.body.alreadySubmitted === true && submittedAgain.body.data?.id === f.invoiceId, "VENDOR_SUBMIT_REPLAY");
  passed("REAL_VENDOR_HTTPS_UPLOAD_MATCH_REPLAY", { companyId: f.companyId, invoiceId: f.invoiceId });
  stage = `company_${f.companyId}_canonical_ap`;
  const { sql } = await import("drizzle-orm");
  const services = await import("../../artifacts/api-server/src/lib/services/mktApPreparationService");
  const actor = { actorId: marker, actorName: "Synthetic DEV acceptance operator (backend session)" };
  await app!.withMarketplaceFinanceDevTransaction(f.companyId, async tx => {
    const other = fixtures.find(row => row.companyId !== f.companyId)!;
    await tx.execute(sql`select set_config('app.marketplace_company_id',${String(other.companyId)},true)`);
    const hidden = await tx.execute(sql`select count(*)::int n from public.mkt_purchase_orders where id=${other.poId}`);
    requireThat(hidden.rows[0]?.n === 0, "CROSS_COMPANY_GUC_SPOOF");
    await tx.execute(sql`select set_config('app.marketplace_company_id',${String(f.companyId)},true)`);
    const preparation = await services.createApPreparation(f.invoiceId!, actor, tx);
    requireThat(preparation.ok && !preparation.alreadyExists, "AP_CREATE");
    f.apId = preparation.preparation.id;
    const repeated = await services.createApPreparation(f.invoiceId!, actor, tx);
    requireThat(repeated.ok && repeated.alreadyExists && repeated.preparation.id === f.apId, "AP_REPLAY");
    requireThat((await services.reviewApPreparation(f.apId, actor, tx)).ok, "AP_REVIEW");
    requireThat((await services.markApPreparationWaitingPayment(f.apId, actor, tx)).ok, "AP_WAITING");
    const handoff = await services.createMarketplaceAccountingHandoff(f.apId, actor, tx);
    requireThat(handoff.ok && !handoff.alreadyExists, "ACCOUNTING_DRAFT_CREATE");
    f.handoffId = handoff.handoffId; f.paymentRequestId = handoff.paymentRequestId;
    const repeatedHandoff = await services.createMarketplaceAccountingHandoff(f.apId, actor, tx);
    requireThat(repeatedHandoff.ok && repeatedHandoff.alreadyExists && repeatedHandoff.handoffId === f.handoffId &&
      repeatedHandoff.paymentRequestId === f.paymentRequestId, "ACCOUNTING_DRAFT_REPLAY");
  });
  const result = (await admin!.query(`select
    (select count(*)::int from public.vendor_invoices where mkt_purchase_order_id=$1) invoices,
    (select count(*)::int from public.vendor_invoice_lines where invoice_id=$2) lines,
    (select count(*)::int from public.mkt_ap_preparations where id=$3 and status='waiting_payment') ap,
    (select count(*)::int from public.payment_requests where id=$4 and status='draft' and paid_amount=0 and journal_entry_id is null) draft,
    (select count(*)::int from public.mkt_accounting_handoffs where id=$5 and accounting_status='draft_not_posted') handoff,
    (select count(*)::int from public.mkt_notification_queue where purchase_order_id=$1) notifications,
    (select count(*)::int from public.activity_logs where mkt_purchase_order_id=$1) audit,
    (select attachment_object_path from public.vendor_invoices where id=$2) object_path`,
  [f.poId, f.invoiceId, f.apId, f.paymentRequestId, f.handoffId])).rows[0];
  requireThat(result.invoices === 1 && result.lines === 2 && result.ap === 1 && result.draft === 1 &&
    result.handoff === 1 && result.notifications === 0 && result.audit >= 5, "COMMITTED_FLOW_COUNTS_OR_AUDIT");
  requireThat(typeof result.object_path === "string" && /^\/objects\/uploads\/[a-f0-9-]+\.pdf$/.test(result.object_path), "STORAGE_OBJECT_PATH");
  f.objectPath = result.object_path;
  const { ObjectStorageService } = await import("../../artifacts/api-server/src/lib/objectStorage");
  const storage = new ObjectStorageService();
  requireThat(await storage.getObjectEntitySize(f.objectPath!) === invoicePdf(f.reference).length, "PRIVATE_STORAGE_BYTES");
  passed("COMPANY_SESSION_AP_ACCOUNTING_DRAFT_REPLAY_AUDIT_NO_NOTIFICATION", { companyId: f.companyId,
    invoiceId: f.invoiceId, apId: f.apId, paymentRequestId: f.paymentRequestId, handoffId: f.handoffId });
}
async function cleanup() {
  if (!seeded) return;
  stage = "owned_fixture_cleanup";
  const { ObjectStorageService } = await import("../../artifacts/api-server/src/lib/objectStorage");
  const storage = new ObjectStorageService();
  for (const f of fixtures) {
    await admin!.query("BEGIN");
    try {
      await admin!.query("SET LOCAL lock_timeout='3s'");
      const owner = (await admin!.query(`select po_number,company_id,vendor_id from public.mkt_purchase_orders where id=$1 for update`, [f.poId])).rows[0];
      requireThat(owner?.po_number === f.reference && owner.company_id === f.companyId && owner.vendor_id === f.supplierId && f.poId !== 14, "CLEANUP_OWNERSHIP");
      const invoices = (await admin!.query(`select id,vendor_invoice_ref,company_id,supplier_id,status::text,
        paid_amount,journal_entry_id,attachment_object_path
        from public.vendor_invoices where mkt_purchase_order_id=$1 for update`, [f.poId])).rows;
      requireThat(invoices.every(row => row.vendor_invoice_ref === f.reference && row.company_id === f.companyId &&
        row.supplier_id === f.supplierId && Number(row.paid_amount) === 0 && row.journal_entry_id == null &&
        ["draft", "submitted", "matched", "ready_for_ap"].includes(row.status)), "CLEANUP_INVOICE_CHANGED");
      const aps = (await admin!.query(`select id,company_id,supplier_id,vendor_invoice_id,mkt_goods_receipt_id
        from public.mkt_ap_preparations where mkt_purchase_order_id=$1 for update`, [f.poId])).rows;
      requireThat(aps.every(row => row.company_id === f.companyId && row.supplier_id === f.supplierId &&
        row.mkt_goods_receipt_id === f.grId && invoices.some(invoice => invoice.id === row.vendor_invoice_id)), "CLEANUP_AP_CHANGED");
      const payments = (await admin!.query(`select id,company_id,supplier_id,status::text,paid_amount,journal_entry_id
        from public.payment_requests where mkt_ap_preparation_id=any($1::int[]) for update`, [aps.map(row => row.id)])).rows;
      requireThat(payments.every(row => row.status === "draft" && Number(row.paid_amount) === 0 &&
        row.journal_entry_id == null && row.company_id === f.companyId && row.supplier_id === f.supplierId), "CLEANUP_REFUSES_PAYMENT_OR_GL");
      const handoffs = (await admin!.query(`select company_id,supplier_id,payment_request_id,accounting_status
        from public.mkt_accounting_handoffs where mkt_purchase_order_id=$1 for update`, [f.poId])).rows;
      requireThat(handoffs.every(row => row.company_id === f.companyId && row.supplier_id === f.supplierId &&
        row.accounting_status === "draft_not_posted" && payments.some(payment => payment.id === row.payment_request_id)), "CLEANUP_HANDOFF_CHANGED");
      const notification = await admin!.query(`select count(*)::int n from public.mkt_notification_queue where purchase_order_id=$1`, [f.poId]);
      requireThat(notification.rows[0].n === 0, "CLEANUP_NOTIFICATION_BOUNDARY_FAILED");
      // Delete only private paths read from this run's verified invoice rows.
      for (const invoice of invoices) {
        const path = invoice.attachment_object_path;
        if (path == null) continue;
        requireThat(typeof path === "string" && /^\/objects\/uploads\/[a-f0-9-]+\.pdf$/.test(path), "CLEANUP_STORAGE_PATH");
        await storage.deletePrivateEntity(path);
        const remainingObject = await admin!.query(`select count(*)::int n from storage.objects
          where bucket_id='private-uploads' and name=$1`, [path.slice("/objects/".length)]);
        requireThat(remainingObject.rows[0].n === 0, "CLEANUP_STORAGE_OBJECT_REMAINS");
      }
      await admin!.query("delete from public.mkt_accounting_handoffs where mkt_purchase_order_id=$1", [f.poId]);
      await admin!.query(`delete from public.payment_requests where mkt_ap_preparation_id in
        (select id from public.mkt_ap_preparations where mkt_purchase_order_id=$1)`, [f.poId]);
      await admin!.query("delete from public.mkt_ap_preparations where mkt_purchase_order_id=$1", [f.poId]);
      await admin!.query(`delete from public.vendor_invoice_lines where invoice_id in
        (select id from public.vendor_invoices where mkt_purchase_order_id=$1)`, [f.poId]);
      await admin!.query("delete from public.vendor_invoices where mkt_purchase_order_id=$1", [f.poId]);
      await admin!.query("delete from public.mkt_po_goods_receipt_items where goods_receipt_id=$1", [f.grId]);
      await admin!.query("delete from public.mkt_po_goods_receipts where id=$1", [f.grId]);
      await admin!.query("delete from public.mkt_po_shipment_items where shipment_id=$1", [f.shipmentId]);
      await admin!.query("delete from public.mkt_po_shipments where id=$1", [f.shipmentId]);
      await admin!.query("delete from public.mkt_purchase_order_lines where po_id=$1", [f.poId]);
      await admin!.query("delete from public.mkt_purchase_orders where id=$1", [f.poId]);
      await admin!.query("delete from public.mkt_vendor_quotes where id=$1 and rfq_id=$2 and vendor_id=$3", [f.quoteId, f.rfqId, f.supplierId]);
      await admin!.query("delete from public.mkt_rfqs where id=$1 and rfq_number=$2", [f.rfqId, f.reference]);
      await admin!.query("delete from public.suppliers where id=$1 and name=$2", [f.supplierId, f.reference]);
      await admin!.query("COMMIT");
    } catch (error) { await admin!.query("ROLLBACK"); throw error; }
  }
  requireThat(JSON.stringify(await po14Fingerprint()) === JSON.stringify(baselinePo14), "PO14_CHANGED");
  passed("OWNED_QA_ROWS_AND_PRIVATE_OBJECTS_CLEANED_PO14_UNCHANGED", { marker, auditHistory: "retained" });
}
async function main() {
  requireThat(mode === "--check" || mode === "--execute", "USE_CHECK_OR_EXECUTE");
  requireThat(mode !== "--execute" || process.env.BIZPORTAL_VENDOR_ACCEPTANCE_EXECUTE_DEV === "true", "EXPLICIT_DEV_EXECUTION_REQUIRED");
  await preflight();
  if (mode === "--check") { passed("READ_ONLY_PREFLIGHT_COMPLETE"); return; }
  console.log(JSON.stringify({ run: marker, scope: "CST-DEV synthetic acceptance", signedAdminHttp: "not tested" }));
  let operationError: unknown;
  try { await seed(); for (const fixture of fixtures) await exercise(fixture); }
  catch (error) { operationError = error; }
  const failedStage = stage;
  await cleanup();
  if (operationError) { stage = failedStage; throw operationError; }
  passed("DEV_VENDOR_BACKEND_AND_CAPABILITY_HTTP_ACCEPTANCE_COMPLETE", { marker, checks: checks.length,
    signedAdminHttp: "requires genuine owner session; not claimed by this harness" });
}
main().catch(error => {
  // Never print Error objects, SQL parameters, request URLs or raw credential errors.
  const message = error instanceof Error && /^QA_[A-Z0-9_]+$/.test(error.message) ? error.message : "QA_UNEXPECTED_FAILURE";
  let cause: unknown = error;
  let sqlState: string | undefined;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    const possibleCode = (cause as Error & { code?: unknown }).code;
    if (typeof possibleCode === "string" && /^[0-9A-Z]{5}$/.test(possibleCode)) sqlState = possibleCode;
    cause = cause.cause;
  }
  console.error(JSON.stringify({ result: "FAIL", stage, code: message, sqlState, marker }));
  process.exitCode = 1;
}).finally(async () => {
  admin?.release();
  if (app) await app.pool.end();
  if (publicCertificateDirectory) rmSync(publicCertificateDirectory, { recursive: true, force: true });
});
