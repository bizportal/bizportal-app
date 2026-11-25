/**
 * Actual existing Sheet importer, matching HTTP route, vendor allocation writer,
 * canonical posting and Payment Request finalizer against disposable PostgreSQL.
 * Only the external Sheets transport / notifications are replaced. All business
 * SQL and signed-cookie parsing execute. The signed identity is a LOCAL test user,
 * never a human Owner session or proof of operational deployment.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import express, { type Response } from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";

const state = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  rows: [] as string[][],
  writes: vi.fn(async () => undefined),
}));
vi.mock("@workspace/db", async () => ({
  ...await import("@workspace/db/schema"),
  db: {},
  pool: {
    query: (...args: any[]) => (state.pool!.query as any)(...args),
    connect: () => state.pool!.connect(),
  },
  getRuntimeDatabaseUrl: () => { throw new Error("BUSINESS_DATABASE_FORBIDDEN_IN_QA"); },
  onMarketplaceFinanceCommit: vi.fn(),
}));
vi.mock("../activityLog.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/marketplaceNotificationQueueService.js", () => ({
  enqueueNotification: vi.fn(async () => undefined),
}));
vi.mock("../google-sheets", async (original) => ({
  ...await original<typeof import("../google-sheets")>(),
  readSpreadsheetValues: async (sheetId: string) => {
    if (!sheetId.startsWith("QA-LOCAL-")) throw new Error("EXTERNAL_SHEET_FORBIDDEN_IN_QA");
    return state.rows;
  },
  writeSpreadsheetValues: (...args: any[]) => (state.writes as any)(...args),
}));

import bankRouter from "../../routes/bank-reconciliation";
import { setProductionSessionCookie } from "../../routes/dev-auth";
import { syncOneBankSheetConfig } from "../bank-sheet-sync";
import { createMarketplaceVendorInvoice, submitMarketplaceVendorInvoice } from "../services/mktVendorInvoiceService.js";
import { createApPreparation, reviewApPreparation, markApPreparationWaitingPayment,
  createMarketplaceAccountingHandoff } from "../services/mktApPreparationService.js";
import { approveMarketplacePaymentRequest } from "./marketplacePaymentApproval";
import { finalizePostedMarketplacePayment } from "./marketplacePaymentFinalization";
import type { VerifiedActor } from "./marketplacePaymentReleaseGate";

// Deliberately constants, not environment-overridable database connections.
const adminUrl = "postgres://postgres@127.0.0.1:55497/postgres";
const databaseName = "po14_bank_ingestion_qa";
const url = "postgres://postgres@127.0.0.1:55497/po14_bank_ingestion_qa";
const actor: VerifiedActor = {
  source: "signed_server_session", role: "super_admin", companyId: 1,
  email: "po14-owner@qa.invalid",
};
let admin: pg.Client;
let server: Server;
let origin: string;
let cookie: string;
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

beforeAll(async () => {
  const bootstrap = new pg.Client({ connectionString: adminUrl });
  await bootstrap.connect();
  try {
    const existing = await bootstrap.query("select 1 from pg_database where datname=$1", [databaseName]);
    if (existing.rowCount) throw new Error("QA_DATABASE_ALREADY_EXISTS: use a fresh disposable container");
    await bootstrap.query(`create database ${databaseName}`);
  } finally { await bootstrap.end(); }
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  for (const file of [
    "20261125_po14_isolated_marketplace_schema_ONLY.sql",
    "20261125_po14_isolated_finance_bank_fixtures_ONLY.sql",
    "20261125_po14_isolated_bank_import_schema_ONLY.sql",
  ]) {
    await admin.query(readFileSync(path.resolve(import.meta.dirname, "../../../../../scripts/sql", file), "utf8"));
  }
  await admin.query(`create table public.users (
    id text primary key,email text not null,role text not null,company_id integer,
    is_active boolean not null,status text,first_name text,last_name text
  )`);
  state.pool = new pg.Pool({ connectionString: url, max: 5 });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = logger as any; next(); });
  app.use("/api", bankRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("QA_HTTP_NOT_LOCAL");
  origin = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  await state.pool?.end();
  await admin?.end();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV", "false");
  vi.stubEnv("BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV", "false");
  vi.stubEnv("BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV", "true");
  vi.stubEnv("BIZPORTAL_SIGNED_OTP_ENABLED_DEV", "true");
  vi.stubEnv("BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV", "false");
  vi.stubEnv("BIZPORTAL_SESSION_SECRET", randomBytes(32).toString("hex"));
  state.writes.mockReset();
  state.writes.mockResolvedValue(undefined);
  logger.warn.mockClear();
  await admin.query(`
    drop trigger if exists qa_fail_import on public.bank_mutations;
    drop trigger if exists qa_fail_bank_audit on public.bank_reconciliation_audit;
    truncate public.users, public.mkt_payment_approval_audit_dev,
    public.bank_reconciliation_audit, public.audit_logs,
    public.accounting_entry_lines, public.accounting_entries,
    public.bank_reconciliation_matches, public.payment_allocations,
    public.payment_matching_groups, public.bank_mutations, public.bank_sheet_configs,
    public.accounting_settings, public.accounting_journals, public.journal_sequences,
    public.chart_of_accounts, public.company_bank_accounts,
    public.mkt_accounting_handoffs, public.payment_requests,
    public.mkt_ap_preparations, public.vendor_invoice_lines, public.vendor_invoices,
    public.mkt_po_goods_receipt_items, public.mkt_po_goods_receipts,
    public.mkt_po_shipment_items, public.mkt_po_shipments,
    public.mkt_purchase_order_lines, public.mkt_purchase_orders, public.suppliers
    restart identity cascade;
    insert into public.users(id,email,role,company_id,is_active,status)
      values('qa-local-owner','po14-owner@qa.invalid','super_admin',1,true,'active');
    insert into public.suppliers(id,company_id,name,is_active)
      values(24,1,'PT Cahaya Sejati Teknologi',true);
    insert into public.mkt_purchase_orders
      (id,po_number,rfq_id,quote_id,company_id,vendor_id,status,total_amount,tax_amount,grand_total,currency_snapshot)
      values(14,'PO-20261117-00014',1,1,1,24,'completed',100000,0,100000,'IDR');
    insert into public.mkt_purchase_order_lines(id,po_id,item_name,qty,unit,unit_price,subtotal)
      values(14,14,'Frozen Tuna Saku',1,'pcs',100000,100000);
    insert into public.mkt_po_shipments(id,po_id,shipment_number,shipment_status)
      values(8,14,'QA-SHIP-8','delivered');
    insert into public.mkt_po_shipment_items(id,shipment_id,po_line_id,line_number,qty)
      values(8,8,14,1,1);
    insert into public.mkt_po_goods_receipts(id,shipment_id,receipt_number,receipt_type,inspection_status)
      values(6,8,'QA-GR-6','full','passed');
    insert into public.mkt_po_goods_receipt_items
      (id,goods_receipt_id,shipment_item_id,received_qty,accepted_qty,rejected_qty)
      values(6,6,8,1,1,0);
    insert into public.chart_of_accounts(id,company_id,code,name,is_active,is_postable,is_header)
      values(301,1,'2-1001-CST','Hutang Usaha QA',true,true,false),
            (302,1,'1-1023-CST','Bank QA',true,true,false);
    insert into public.company_bank_accounts(id,company_id,account_number,name,coa_id,is_active,account_type)
      values(11,1,'QA-BANK-11','Bank QA',302,true,'bank'),
            (12,1,'QA-BANK-12','Other Bank QA',302,true,'bank'),
            (31,3,'QA-BANK-31','Other Company QA',null,true,'bank');
    insert into public.bank_sheet_configs
      (id,company_id,sheet_id,tab_name,label,bank_account_id,bank_account_number,is_active)
      values(1,1,'QA-LOCAL-PO14','mutasidev','PO14 isolated',11,'QA-BANK-11',true);
    insert into public.accounting_journals(id,company_id,name,code,type)
      values(1,1,'Bank QA','BANK','bank');
    insert into public.accounting_settings(company_id,bank_journal_id,ap_account_id)
      values(1,1,301);
  `);
  state.rows = [
    ["Tanggal", "Keterangan", "Debit", "Kredit"],
    ["25/11/2026", "PT Cahaya Sejati Teknologi QA-PO14-INTERNAL-TEST-ONLY", "100.000", "0"],
  ];
  let header = "";
  setProductionSessionCookie({ append: (_name: string, value: string) => { header = value; } } as Response, {
    id: "qa-local-owner", email: actor.email, issuedAt: Date.now(), expiresAt: Date.now() + 60000,
  });
  cookie = header.split(";", 1)[0]!;
});

async function http(endpoint: string, body: unknown, sessionCookie = cookie) {
  const response = await fetch(`${origin}/api${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-company-id": "1", cookie: sessionCookie },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

async function prepareInvoice(approve = true) {
  const scoped = drizzle(admin, { schema });
  const vendor = { actorType: "vendor" as const, actorId: "QA-PO14" };
  const created = await createMarketplaceVendorInvoice({
    poId: 14, grId: 6, vendorInvoiceRef: "QA-PO14-INTERNAL-TEST-ONLY",
    invoiceDate: new Date("2026-11-25T00:00:00Z"), currency: "IDR",
    totalAmount: 100000, taxAmount: 0, grandTotal: 100000,
    supplierId: 24, supplierName: "PT Cahaya Sejati Teknologi", companyId: 1,
    lines: [{ poLineId: 14, quantity: 1, unitPrice: 100000, subtotal: 100000, name: "Frozen Tuna Saku", unit: "pcs" }],
    attachment: { objectPath: "isolated/qa-po14/TEST-ONLY.pdf", fileName: "TEST-ONLY.pdf", contentType: "application/pdf", size: 27 },
  }, vendor, scoped as never);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.code);
  const invoiceId = created.invoice.id;
  expect(await submitMarketplaceVendorInvoice(invoiceId, vendor, scoped as never))
    .toMatchObject({ ok: true, invoice: { status: "ready_for_ap", threeWayMatchStatus: "passed" } });
  const financeActor = { actorId: actor.email, actorName: "Local test Owner" };
  const prep = await createApPreparation(invoiceId, financeActor, scoped as never);
  if (!prep.ok) throw new Error(prep.code);
  expect(await reviewApPreparation(prep.preparation.id, financeActor, scoped as never)).toMatchObject({ ok: true });
  expect(await markApPreparationWaitingPayment(prep.preparation.id, financeActor, scoped as never)).toMatchObject({ ok: true });
  const handoff = await createMarketplaceAccountingHandoff(prep.preparation.id, financeActor, scoped as never);
  if (!handoff.ok) throw new Error(handoff.code);
  if (approve) {
    const dialect = new PgDialect();
    await admin.query("begin");
    try {
      expect(await approveMarketplacePaymentRequest({ execute: async (statement: any) => {
        const q = dialect.sqlToQuery(statement);
        return admin.query(q.sql, q.params) as any;
      } }, actor, handoff.paymentRequestId)).toMatchObject({ status: "approved", replay: false });
      await admin.query("commit");
    } catch (e) { await admin.query("rollback"); throw e; }
  }
  return { invoiceId, requestId: handoff.paymentRequestId };
}

async function importMutation() {
  expect(await syncOneBankSheetConfig(1)).toMatchObject({ ok: true, imported: 1, existing: 0 });
  const result = await admin.query("select * from public.bank_mutations order by id");
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    source: "google_sheet", source_classification: "actual_bank_mutation", sheet_config_id: 1,
    company_id: 1, direction: "OUT", status: "unmatched", journal_entry_id: null,
    import_row_id: null, import_batch_id: null,
  });
  return Number(result.rows[0].id);
}

async function match(mutationId: number) {
  const response = await http("/bank-reconciliation/run-matching", { ids: [mutationId] });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function allocate(mutationId: number, invoiceId: number) {
  return http(`/bank-reconciliation/${mutationId}/vendor-invoice-payment-batch`, { vendor_invoice_ids: [invoiceId] });
}

async function counts() {
  const r = await admin.query(`select
    (select count(*)::integer from public.bank_mutations) mutations,
    (select count(*)::integer from public.accounting_entries) journals,
    (select count(*)::integer from public.accounting_entry_lines) lines,
    (select count(*)::integer from public.payment_allocations) allocations,
    (select count(*)::integer from public.payment_matching_groups) groups,
    (select count(*)::integer from public.bank_reconciliation_audit) bank_audits`);
  return r.rows[0];
}

describe("PO14 actual bank ingestion + automatic matching + allocation + GL, isolated SQL", () => {
  it("executes the existing complete service/HTTP chain, then replays without duplicate money or audits", async () => {
    const refs = await prepareInvoice();
    const mutationId = await importMutation();
    expect(await syncOneBankSheetConfig(1)).toMatchObject({ imported: 0, existing: 1 });
    const matching = await match(mutationId);
    expect(matching.failed, JSON.stringify(matching)).toBe(0);
    const candidates = await admin.query("select candidate_id,status from public.bank_reconciliation_matches where mutation_id=$1 and candidate_type='vendor_invoice'", [mutationId]);
    expect(candidates.rows).toHaveLength(1);
    expect(Number(candidates.rows[0].candidate_id)).toBe(refs.invoiceId);
    expect(candidates.rows[0].status).toBe("candidate");
    const picker = await fetch(`${origin}/api/bank-reconciliation/${mutationId}/vendor-invoice-candidates`, {
      headers: { cookie, "x-company-id": "1" },
    });
    const pickerBody = await picker.json() as any;
    expect(picker.status, JSON.stringify(pickerBody)).toBe(200);
    expect(pickerBody.invoices).toEqual([expect.objectContaining({
      id: refs.invoiceId, marketplaceAp: true, outstanding: 100000,
    })]);
    expect(await counts()).toMatchObject({ mutations: 1, journals: 0, allocations: 0 });
    const allocated = await allocate(mutationId, refs.invoiceId);
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(200);
    expect(allocated.body).toMatchObject({ status: "approved_pending_posting", mutation_id: mutationId });
    const posted = await http(`/bank-reconciliation/${mutationId}/post`, {});
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect((await finalizePostedMarketplacePayment(admin, actor, refs.requestId, mutationId)).status).toBe("CONFIRMED");
    const beforeReplay = await counts();
    expect(await syncOneBankSheetConfig(1)).toMatchObject({ imported: 0, existing: 1 });
    expect((await http(`/bank-reconciliation/${mutationId}/post`, {})).status).toBe(200);
    expect((await finalizePostedMarketplacePayment(admin, actor, refs.requestId, mutationId)).status).toBe("REPLAY");
    expect((await allocate(mutationId, refs.invoiceId)).status).toBe(409);
    await match(mutationId);
    expect(await counts()).toEqual(beforeReplay);
    const summary = await admin.query(`select vi.status::text invoice_status,pr.status::text payment_status,
      pr.paid_amount::text paid,ae.status::text journal_status,ae.total_debit::text debit,ae.total_credit::text credit,
      bm.status bank_status,bm.accounting_posted,bm.reconciliation_status,
      (select count(*)::integer from public.mkt_payment_approval_audit_dev) approval_audits,
      (select count(*)::integer from public.audit_logs) finalization_audits
      from public.payment_requests pr join public.vendor_invoices vi on vi.id=$2
      join public.bank_mutations bm on bm.id=$3
      join public.accounting_entries ae on ae.id=bm.journal_entry_id where pr.id=$1`,
    [refs.requestId, refs.invoiceId, mutationId]);
    expect(summary.rows[0]).toMatchObject({ invoice_status: "ready_for_ap", payment_status: "paid",
      journal_status: "posted", bank_status: "posted", accounting_posted: true,
      reconciliation_status: "reconciled", approval_audits: 1, finalization_audits: 1 });
    expect(Number(summary.rows[0].paid)).toBe(100000);
    expect(Number(summary.rows[0].debit)).toBe(100000);
    expect(Number(summary.rows[0].credit)).toBe(100000);
    expect(beforeReplay).toMatchObject({ mutations: 1, journals: 1, lines: 2, allocations: 1, groups: 1 });
  }, 30000);

  it("refuses matching/allocation before the real Payment Request approval", async () => {
    const refs = await prepareInvoice(false);
    const mutationId = await importMutation();
    await match(mutationId);
    expect((await admin.query("select * from public.bank_reconciliation_matches where candidate_type='vendor_invoice'")).rowCount).toBe(0);
    const denied = await allocate(mutationId, refs.invoiceId);
    expect(denied.status, JSON.stringify(denied.body)).toBe(409);
    expect(await counts()).toMatchObject({ journals: 0, allocations: 0, groups: 0 });
  });

  it("serializes concurrent imports and allocations so only one bank payment is created", async () => {
    const refs = await prepareInvoice();
    const imports = await Promise.all([syncOneBankSheetConfig(1), syncOneBankSheetConfig(1)]);
    expect(imports.map(r => r.imported).sort()).toEqual([0, 1]);
    const mutationId = Number((await admin.query("select id from public.bank_mutations")).rows[0].id);
    await match(mutationId);
    const attempts = await Promise.all([allocate(mutationId, refs.invoiceId), allocate(mutationId, refs.invoiceId)]);
    expect(attempts.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await counts()).toMatchObject({ mutations: 1, journals: 1, lines: 2, allocations: 1, groups: 1 });
  });

  it("requires full Marketplace allocation and rejects the generic approval shortcut", async () => {
    const refs = await prepareInvoice();
    const mutationId = await importMutation();
    await match(mutationId);
    const candidate = (await admin.query("select id from public.bank_reconciliation_matches where mutation_id=$1 and candidate_type='vendor_invoice'", [mutationId])).rows[0];
    const partial = await http(`/bank-reconciliation/${mutationId}/vendor-invoice-payment-batch`, {
      vendor_invoice_ids: [refs.invoiceId], allocations: [{ vendor_invoice_id: refs.invoiceId, amount: 50000 }],
    });
    expect(partial.body.code).toBe("MARKETPLACE_FULL_ALLOCATION_REQUIRED");
    const generic = await http(`/bank-reconciliation/${mutationId}/approve`, {
      match_id: candidate.id, candidate_type: "vendor_invoice", candidate_id: refs.invoiceId,
      candidate_source: "public.vendor_invoices",
    });
    expect(generic.body.code).toBe("MARKETPLACE_VENDOR_BATCH_REQUIRED");
    expect(await counts()).toMatchObject({ journals: 0, allocations: 0, groups: 0 });
  });

  it("rolls back every imported row when PostgreSQL rejects a later statement row", async () => {
    state.rows.push(["26/11/2026", "QA FAIL IMPORT", "50.000", "0"]);
    await admin.query(`create or replace function public.qa_reject_import() returns trigger language plpgsql as $$
      begin if new.description='QA FAIL IMPORT' then raise exception 'QA_IMPORT_FAULT'; end if; return new; end $$;
      create trigger qa_fail_import before insert on public.bank_mutations for each row execute function public.qa_reject_import()`);
    await expect(syncOneBankSheetConfig(1)).rejects.toThrow("QA_IMPORT_FAULT");
    expect(await counts()).toMatchObject({ mutations: 0, journals: 0, allocations: 0 });
    expect(state.writes).not.toHaveBeenCalled();
  });

  it("rolls back the actual allocation/journal writer if its approval audit cannot be saved", async () => {
    const refs = await prepareInvoice();
    const mutationId = await importMutation();
    await match(mutationId);
    const before = await counts();
    await admin.query(`create or replace function public.qa_reject_bank_audit() returns trigger language plpgsql as $$
      begin if new.action='MATCH_APPROVED' then raise exception 'QA_ALLOCATION_AUDIT_FAULT'; end if; return new; end $$;
      create trigger qa_fail_bank_audit before insert on public.bank_reconciliation_audit for each row execute function public.qa_reject_bank_audit()`);
    const denied = await allocate(mutationId, refs.invoiceId);
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain("QA_ALLOCATION_AUDIT_FAULT");
    expect(await counts()).toEqual(before);
    expect((await admin.query("select journal_entry_id from public.bank_mutations where id=$1", [mutationId])).rows[0].journal_entry_id).toBeNull();
  });

  it.each(["company", "bank_account", "inactive", "canonical_key"])("denies tampered Sheet provenance: %s", async (kind) => {
    const refs = await prepareInvoice();
    const mutationId = await importMutation();
    if (kind === "company") await admin.query("update public.bank_sheet_configs set company_id=3,bank_account_id=31 where id=1");
    if (kind === "bank_account") await admin.query("update public.bank_sheet_configs set bank_account_id=12 where id=1");
    if (kind === "inactive") await admin.query("update public.bank_sheet_configs set is_active=false where id=1");
    if (kind === "canonical_key") await admin.query("update public.bank_mutations set canonical_key='forged' where id=$1", [mutationId]);
    const denied = await allocate(mutationId, refs.invoiceId);
    expect(denied.status, JSON.stringify(denied.body)).toBe(409);
    expect(await counts()).toMatchObject({ journals: 0, allocations: 0, groups: 0 });
  });

  it("checks the signed cookie and current SQL role before accepting a bank allocation", async () => {
    const refs = await prepareInvoice();
    const mutationId = await importMutation();
    expect((await http(`/bank-reconciliation/${mutationId}/vendor-invoice-payment-batch`, { vendor_invoice_ids: [refs.invoiceId] }, "")).status).toBe(401);
    expect((await http(`/bank-reconciliation/${mutationId}/vendor-invoice-payment-batch`, { vendor_invoice_ids: [refs.invoiceId] }, cookie + "invalid")).status).toBe(401);
    await admin.query("update public.users set role='finance' where id='qa-local-owner'");
    expect((await allocate(mutationId, refs.invoiceId)).status).toBe(403);
    expect(await counts()).toMatchObject({ journals: 0, allocations: 0, groups: 0 });
  });
});
