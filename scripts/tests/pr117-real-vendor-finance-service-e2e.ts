/**
 * PR117 — real canonical Vendor Invoice→match→AP→Accounting services against
 * original PR107/108 guarded SQL (stripped ONLY in disposable PG16 container).
 * All fixture records are synthetic; runtime services, GCP and CST-DEV untouched.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { sql, getTableColumns } from "drizzle-orm";
import {
  db, pool, callbacks,
  mktPurchaseOrdersTable, mktPurchaseOrderLinesTable,
  mktPoShipmentsTable, mktPoShipmentItemsTable,
  mktPoGoodsReceiptsTable, mktPoGoodsReceiptItemsTable,
  vendorInvoicesTable, vendorInvoiceLinesTable,
  mktApPreparationsTable, paymentRequestsTable, mktAccountingHandoffsTable,
} from "./pr117-vendor-db-stub";
import {
  createMarketplaceVendorInvoice,
  submitMarketplaceVendorInvoice,
} from "../../artifacts/api-server/src/lib/services/mktVendorInvoiceService";
import {
  createApPreparation, reviewApPreparation,
  markApPreparationWaitingPayment, createMarketplaceAccountingHandoff,
} from "../../artifacts/api-server/src/lib/services/mktApPreparationService";

const BASE = "scripts/tests/pr107-finance-synthetic-baseline.sql";
const INSTALL107 = "scripts/sql/20261117_pr107_finance_company_roles_RLS_REVIEW_ONLY.sql";
const BACK107 = "scripts/sql/20261117_pr107_finance_company_roles_ROLLBACK_REVIEW_ONLY.sql";
const INSTALL108 = "scripts/sql/20261117_pr108_session_bound_vendor_lock_REVIEW_ONLY.sql";
const BACK108 = "scripts/sql/20261117_pr108_session_bound_vendor_lock_ROLLBACK_REVIEW_ONLY.sql";
const EXPECTED_URL = "postgresql://postgres:synthetic-admin-only@pr117pg:5432/cst_pr107_ci";
const adminUrl = process.env.PR117_DISPOSABLE_ADMIN_URL || "";
if (process.env.PR117_DISPOSABLE_INTEGRATION !== "true" ||
    adminUrl !== EXPECTED_URL ||
    process.env.PR117_DISPOSABLE_PG_URL !==
      "postgresql://bizportal_finance_cst_login_dev:synthetic-cst-only@pr117pg:5432/cst_pr107_ci") {
  throw Error("PR117_REFUSE_NON_DISPOSABLE_DATABASE_OR_ENV");
}
const admin = new pg.Client({ connectionString: adminUrl, ssl: false, connectionTimeoutMillis: 3000 });
const actor = { actorType: "vendor" as const, actorId: "10", actorName: "TEST-DEV-Synthetic-Supplier" };
const apActor = { actorId: "QA-DEV-SUPER-ADMIN", actorName: "Synthetic Finance Tester" };
const token = "a".repeat(64);
const divaToken = "b".repeat(64);
const invoiceRef = "TEST-DEV-PR117-CST-FINANCE-001";
const expectedTables = [
  mktPurchaseOrdersTable, mktPurchaseOrderLinesTable,
  mktPoShipmentsTable, mktPoShipmentItemsTable,
  mktPoGoodsReceiptsTable, mktPoGoodsReceiptItemsTable,
  vendorInvoicesTable, vendorInvoiceLinesTable,
  mktApPreparationsTable, paymentRequestsTable, mktAccountingHandoffsTable,
];
class ExpectedRollback extends Error {}

function reviewOnlySQL(file: string): string {
  const original = readFileSync(file, "utf8");
  const marker = "DO $no_go$\nBEGIN\n";
  const end = "$no_go$;\n";
  assert.equal(original.split(marker).length, 2, "Exactly one unconditional review guard required: " + file);
  const a = original.indexOf(marker);
  const b = original.indexOf(end, a);
  assert(a >= 0 && b > a, "Guard shape changed: " + file);
  const result = original.slice(0, a) + original.slice(b + end.length);
  assert(result.includes("BEGIN;") && result.trimEnd().endsWith("COMMIT;"), "Reviewed SQL transaction boundaries missing");
  assert(result.includes("COMMIT;"));
  assert(!result.includes("DO $no_go$"), "Guard stripped in-memory only");
  return result;
}
async function addMissingActualServiceColumns() {
  // PR107 baseline deliberately contains only security-relevant columns.
  // For integration testing, add remaining fields from the canonical Drizzle
  // schemas without weakening its actual installed policies or grants.
  await admin.query("CREATE TYPE mkt_po_status AS ENUM ('pending','confirmed','in_progress','delivered','completed','cancelled','issued','vendor_accepted','revision_requested','vendor_rejected','production','ready_to_ship','in_transit','partially_delivered','closed','rejected_goods')");
  await admin.query("CREATE TYPE vi_status AS ENUM ('draft','submitted','posted','matched','ready_for_ap','paid','cancelled')");
  await admin.query("CREATE TYPE pay_req_status AS ENUM ('draft','submitted','approved','rejected','paid','cancelled')");
  await admin.query("CREATE TYPE mkt_ap_preparation_status AS ENUM ('ap_preparation','finance_review','waiting_payment')");
  const allowedTypes = /^(?:serial|integer|text|timestamp|date|boolean|jsonb|mkt_po_status|vi_status|pay_req_status|mkt_ap_preparation_status|numeric\(\d+,\s*\d+\))$/;
  let n = 0;
  for (const table of expectedTables) {
    const name = (table as any)[Symbol.for("drizzle:Name")] as string;
    assert(/^[a-z_]+$/.test(name));
    const present = await admin.query(
      "select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1",
      [name],
    );
    const existing = new Map(present.rows.map((row: any) => [row.column_name, row.data_type]));
    for (const col of Object.values(getTableColumns(table)) as any[]) {
      assert(/^[a-z_]+$/.test(col.name));
      const type = col.getSQLType();
      assert(allowedTypes.test(type), "Unexpected canonical SQL type " + type);
      if (!existing.has(col.name)) {
        // Nullable when not supplied by this synthetic fixture; the actual
        // canonical writers continue to supply their own required values.
        await admin.query(`alter table public."${name}" add column "${col.name}" ${type}`);
        n++;
        continue;
      }
      // The minimal PR107 security fixture uses TEXT in a few places where
      // production Drizzle expects a timestamp/numeric/integer. Correct only
      // these safe casts in disposable CI; never change live column types.
      if (existing.get(col.name) === "text" &&
          (type === "timestamp" || type === "integer" || /^numeric\(/.test(type))) {
        await admin.query(`alter table public."${name}" alter column "${col.name}"
          type ${type} using nullif("${col.name}",'')::${type}`);
      }
    }
  }
  assert(n >= 80, "Canonical columns unexpectedly incomplete");
  console.log("PR117_REAL_DRIZZLE_COLUMN_PARITY_READY", n);
}
async function setup() {
  await admin.connect();
  const role = await admin.query("select current_database() db, current_user usr");
  assert.equal(role.rows[0].db, "cst_pr107_ci");
  assert.equal(role.rows[0].usr, "postgres");
  await admin.query(readFileSync(BASE, "utf8"));
  for (const path of [INSTALL107, BACK107, INSTALL108, BACK108]) {
    // The original files must NOT be directly executable. PostgreSQL keeps
    // the explicit BEGIN aborted after the expected exception; reset it.
    await assert.rejects(admin.query(readFileSync(path, "utf8")));
    await admin.query("ROLLBACK");
  }
  await admin.query(reviewOnlySQL(INSTALL107));
  await admin.query(reviewOnlySQL(INSTALL108));
  await addMissingActualServiceColumns();
  await admin.query(`
    create table public.accounting_entries(id integer primary key,company_id integer);
    update public.mkt_purchase_orders
      set vendor_token=case when id=11 then repeat('a',64) else repeat('b',64) end,
          vendor_token_expires_at=(now() at time zone 'UTC')+interval '1 day'
      where id in (11,31);
    update public.mkt_purchase_order_lines set item_name='TEST-DEV-ITEM',qty=1,
      unit_price=100,subtotal=100,unit='KG' where id in (21,41);
    update public.mkt_po_shipment_items
      set line_number=1,qty=1,po_line_id=case when id=22 then 21 else 41 end
      where id in (22,42);
    update public.mkt_po_goods_receipt_items
      set shipment_item_id=case when id=23 then 22 else 42 end,
          received_qty=1,accepted_qty=1,rejected_qty=0,condition='GOOD'
      where id in (23,43);
    update public.mkt_purchase_orders set currency_snapshot='IDR',
      total_amount=case when id=11 then 200 else 100 end,
      grand_total=case when id=11 then 200 else 100 end where id in (11,31);
    -- Second synthetic line demonstrates restricted, parameterized multi-line inserts.
    insert into public.mkt_purchase_order_lines(id,po_id,item_name,qty,unit_price,subtotal,unit)
      values(22,11,'TEST-DEV-SECOND-ITEM',2,50,100,'KG');
    insert into public.mkt_po_shipment_items(id,shipment_id,po_line_id,line_number,qty)
      values(24,12,22,2,2);
    insert into public.mkt_po_goods_receipt_items
      (id,goods_receipt_id,shipment_item_id,received_qty,accepted_qty,rejected_qty,condition)
      values(25,13,24,2,2,0,'GOOD');
    alter role bizportal_finance_cst_login_dev LOGIN PASSWORD 'synthetic-cst-only';
    alter role bizportal_finance_diva_login_dev LOGIN PASSWORD 'synthetic-diva-only';
  `);
  const counts = await admin.query(`
    select
      (select count(*) from pg_policies where schemaname='public'
         and policyname like 'pr50_finance_dev_%') as baseline,
      (select count(*) from pg_policies where schemaname='public'
         and policyname='pr107_company_role_restrictive_all') as tenant,
      (select count(*) from pg_policies where schemaname='public'
         and policyname in ('pr108_definer_read','pr108_definer_lock')) as owner
  `);
  assert.equal(Number(counts.rows[0].baseline),18);
  assert.equal(Number(counts.rows[0].tenant),11);
  assert.equal(Number(counts.rows[0].owner),6);
  console.log("PR117_REVIEW_ONLY_RLS_FUNCTION_STAGED_DISPOSABLE_PASS");
}
async function companyInvoiceTest() {
  let rollback = false;
  try {
    await db.transaction(async tx => {
      await tx.execute(sql.raw("select set_config('app.marketplace_company_id','3',true)"));
      const identity = await tx.execute(sql.raw(
        "select current_user usr, session_user login, row_security_active('public.vendor_invoices'::regclass) rls",
      ));
      assert.deepEqual(identity.rows[0], {
        usr: "bizportal_finance_cst_login_dev",
        login: "bizportal_finance_cst_login_dev",
        rls: true,
      });
      const otherTenant = await tx.execute(sql.raw("select count(*)::int n from public.mkt_purchase_orders where id=31"));
      assert.equal(Number(otherTenant.rows[0].n),0, "CST LOGIN must never see Diva even with tenant GUC=3");
      const foreignLock = await tx.execute(sql`
        SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
          ${31}::integer, ${33}::integer, ${35}::integer, ${divaToken}::text
        ) AS locked`);
      assert.equal(foreignLock.rows[0]?.locked,false);
      await tx.execute(sql.raw("select set_config('app.marketplace_company_id','1',true)"));
      const input = {
        poId: 11,
        grId: 13,
        vendorInvoiceRef: invoiceRef,
        vendorToken: token,
        invoiceDate: new Date("2026-11-17T00:00:00Z"),
        currency: "IDR",
        totalAmount: 200,
        taxAmount: 0,
        grandTotal: 200,
        notes: "TEST DEV ONLY — isolated, no real goods, no payment",
        lines: [
          { poLineId: 21, quantity: 1, unitPrice: 100, subtotal: 100, taxAmount: 0, name: "QA Item", unit: "KG" },
          { poLineId: 22, quantity: 2, unitPrice: 50, subtotal: 100, taxAmount: 0, name: "QA Item Two", unit: "KG" },
        ],
        attachment: {
          objectPath: "TEST-DEV-NOT-UPLOADED/qa-only.png",
          fileName: "TEST-DEV-SYNTHETIC-NO-DELIVERY.png",
          contentType: "image/png",
          size: 512,
        },
        supplierId: 10,
        supplierName: "TEST-DEV-Vendor",
        companyId: 1,
        createdBy: "TEST-DEV-ROLE",
      };
      const denied = await createMarketplaceVendorInvoice({
        ...input, vendorToken: "f".repeat(64),
      }, actor, tx as unknown as typeof db);
      assert.deepEqual(denied,{ok:false,code:"PO_NOT_FOUND"});
      const created = await createMarketplaceVendorInvoice(input,actor,tx as unknown as typeof db);
      assert(created.ok, "Real canonical Vendor Invoice creation refused valid session-bound lock");
      if (!created.ok) throw Error("INVOICE_CREATE_REFUSED");
      assert.equal(created.alreadyExists,false);
      assert.equal(created.invoice.companyId,1);
      assert.equal(created.lines.length,2);
      const second = await createMarketplaceVendorInvoice(input,actor,tx as unknown as typeof db);
      assert(second.ok);
      if(!second.ok)throw Error("REPLAY_REFUSED");
      assert.equal(second.alreadyExists,true);
      assert.equal(second.invoice.id,created.invoice.id);
      console.log("PR117_REAL_VENDOR_INVOICE_SECURITY_DEFINER_LOCK_AND_REPLAY_PASS");

      const submitted = await submitMarketplaceVendorInvoice(created.invoice.id,actor,tx as unknown as typeof db);
      assert(submitted.ok, "Actual 3-way-match service failed");
      if(!submitted.ok)throw Error("MATCH_FAILED");
      if (submitted.match?.status !== "passed") {
        console.error("PR117_SYNTHETIC_MATCH_REASONS", JSON.stringify(submitted.match?.reasons ?? []));
      }
      assert.equal(submitted.match?.status,"passed");
      assert.equal(submitted.invoice.status,"ready_for_ap");
      const submittedAgain=await submitMarketplaceVendorInvoice(created.invoice.id,actor,tx as unknown as typeof db);
      assert(submittedAgain.ok && submittedAgain.alreadyExists===true);
      console.log("PR117_REAL_VENDOR_INVOICE_THREE_WAY_MATCH_AND_REPLAY_PASS");

      const ap = await createApPreparation(created.invoice.id,apActor,tx as unknown as typeof db);
      assert(ap.ok, "Actual AP service refused eligible invoice");
      if(!ap.ok)throw Error("AP_CREATE_REFUSED");
      assert.equal(ap.alreadyExists,false);
      const apAgain = await createApPreparation(created.invoice.id,apActor,tx as unknown as typeof db);
      assert(apAgain.ok && apAgain.alreadyExists===true);
      const apId = ap.preparation.id;
      assert((await reviewApPreparation(apId,apActor,tx as unknown as typeof db)).ok);
      assert((await markApPreparationWaitingPayment(apId,apActor,tx as unknown as typeof db)).ok);
      const handoff=await createMarketplaceAccountingHandoff(apId,apActor,tx as unknown as typeof db);
      assert(handoff.ok, "Actual Accounting handoff service refused eligible AP");
      if(!handoff.ok)throw Error("HANDOFF_REFUSED");
      assert.equal(handoff.alreadyExists,false);
      const replay=await createMarketplaceAccountingHandoff(apId,apActor,tx as unknown as typeof db);
      assert(replay.ok && replay.alreadyExists===true);
      assert.equal(replay.handoffId,handoff.handoffId);
      assert.equal(replay.paymentRequestId,handoff.paymentRequestId);
      console.log("PR117_REAL_AP_WAITING_PAYMENT_ACCOUNTING_DRAFT_REPLAY_PASS");

      const result=await tx.execute(sql`
        select
          (select count(*)::int from public.vendor_invoices where vendor_invoice_ref=${invoiceRef}) invoices,
          (select count(*)::int from public.mkt_ap_preparations where vendor_invoice_id=${created.invoice.id} and status='waiting_payment') aps,
          (select count(*)::int from public.payment_requests where mkt_ap_preparation_id=${apId} and status='draft' and paid_amount=0 and journal_entry_id is null) drafts,
          (select count(*)::int from public.mkt_accounting_handoffs where ap_preparation_id=${apId} and accounting_status='draft_not_posted') handoffs
      `);
      assert.deepEqual(result.rows[0],{invoices:1,aps:1,drafts:1,handoffs:1});
      assert(callbacks.length>=2,"Deferred audit callbacks absent");
      const gl = await tx.execute(sql.raw("select has_table_privilege(current_user,'public.accounting_entries','INSERT') gl"));
      assert.equal(gl.rows[0].gl,false);
      console.log("PR117_NO_GL_NO_EXTERNAL_NOTIFICATION_SCHEDULED_PASS");
      throw new ExpectedRollback("ROLLBACK_SYNTHETIC_BUSINESS_TRANSACTIONS");
    });
  } catch(error) {
    if (!(error instanceof ExpectedRollback))throw error;
    rollback=true;
  }
  assert(rollback);
  const post=await admin.query("select count(*)::int n from public.vendor_invoices where vendor_invoice_ref=$1",[invoiceRef]);
  assert.equal(post.rows[0].n,0);
  console.log("PR117_REAL_SERVICE_WRITES_ROLLED_BACK_PASS");
}
async function revertStaging() {
  await pool.end();
  await admin.query(`
    alter role bizportal_finance_cst_login_dev NOLOGIN PASSWORD NULL;
    alter role bizportal_finance_diva_login_dev NOLOGIN PASSWORD NULL;
  `);
  await admin.query(reviewOnlySQL(BACK108));
  await admin.query(reviewOnlySQL(BACK107));
  const result=await admin.query(`
    select
      (select count(*)::int from pg_policies where schemaname='public'
         and policyname like 'pr50_finance_dev_%') baseline,
      (select count(*)::int from pg_roles where rolname in
         ('bizportal_finance_cst_login_dev','bizportal_finance_diva_login_dev','bizportal_finance_parent_lock_owner_dev')) roles,
      (select count(*)::int from pg_namespace where nspname='finance_ops_private') private_schemas
  `);
  assert.deepEqual(result.rows[0],{baseline:18,roles:0,private_schemas:0});
  console.log("PR117_ROLES_FUNCTION_POLICIES_ROLLBACK_TO_18_PASS");
}
async function main() {
  try {
    await setup();
    await companyInvoiceTest();
    await revertStaging();
    console.log("PR117_CANONICAL_VENDOR_INVOICE_TO_ACCOUNTING_PG16_INTEGRATION_PASS");
  } finally {
    try { await pool.end(); } catch {}
    try { await admin.end(); } catch {}
  }
}
main().catch(error => {
  console.error("PR117_INTEGRATION_FAILED",error instanceof Error?error.message:"unknown");
  if (error instanceof Error) {
    console.error("PR117_SYNTHETIC_STACK", (error.stack ?? "").split("\n").slice(0,7).join(" | "));
  }
  const code = error?.cause?.code ?? error?.code;
  if(typeof code==="string" && /^[A-Z0-9]{5}$/.test(code)){
    console.error("PR117_POSTGRES_SQLSTATE",code);
  }
  process.exitCode=1;
});
