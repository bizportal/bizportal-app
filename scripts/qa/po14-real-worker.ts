/**
 * Real PO14 service execution in one disposable PostgreSQL database.
 * The authenticated parent supplies the server-verified actor over stdin.
 * This worker creates no session, cookie, credential, business-DB connection,
 * external Sheet request, or outbound notification. Use only the fixed bundle.
 */
import pg from "pg";
import { randomBytes } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { configureIsolatedWorkerDatabase, db, pool, flushQaPostCommitCallbacks, isolatedWorkerPoolClients } from "./po14-worker-shims/db";
import { cleanupPo14WorkerDatabase } from "./po14-worker-cleanup";
import { flushSuppressedNotificationIntents } from "./po14-worker-shims/notifications";
import { createMarketplaceVendorInvoice, submitMarketplaceVendorInvoice } from "../../artifacts/api-server/src/lib/services/mktVendorInvoiceService";
import { createApPreparation, reviewApPreparation, markApPreparationWaitingPayment,
  createMarketplaceAccountingHandoff } from "../../artifacts/api-server/src/lib/services/mktApPreparationService";
import { approveMarketplacePaymentRequest } from "../../artifacts/api-server/src/lib/finance/marketplacePaymentApproval";
import { finalizePostedMarketplacePayment } from "../../artifacts/api-server/src/lib/finance/marketplacePaymentFinalization";
import type { VerifiedActor } from "../../artifacts/api-server/src/lib/finance/marketplacePaymentReleaseGate";
import { syncOneBankSheetConfig } from "../../artifacts/api-server/src/lib/bank-sheet-sync";
import { allocateVendorInvoiceBankBatch, matchLocalMutation, postBankMutationCanonical } from "../../artifacts/api-server/src/routes/bank-reconciliation";
import marketplaceSchema from "../sql/20261125_po14_isolated_marketplace_schema_ONLY.sql";
import bankSchema from "../sql/20261125_po14_isolated_finance_bank_fixtures_ONLY.sql";
import ingestionSchema from "../sql/20261125_po14_isolated_bank_import_schema_ONLY.sql";

const reference = "PO-20261117-00014";
const bootstrapUrl = "postgres://postgres@127.0.0.1:55495/finance_approval_qa";
const databaseName = `po14_bank_ingestion_qa_${randomBytes(6).toString("hex")}`;
let bootstrap: pg.Client | undefined;
let client: pg.Client | undefined;
let created = false;
let removed = false;
let cancelled = false;
let cleanupPromise: Promise<void> | undefined;
let currentStage = "validate_input";

function assert(ok: unknown, code: string): asserts ok {
  if (cancelled) throw new Error("QA_CANCELLED");
  if (!ok) throw new Error(code);
}
function stage(name: string) { assert(!cancelled, "QA_CANCELLED"); currentStage = name; }
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

async function readInput(): Promise<{ actor: VerifiedActor; runId: string }> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    assert(Buffer.byteLength(raw) <= 8192, "QA_INPUT_TOO_LARGE");
  }
  const input = JSON.parse(raw);
  assert(input?.version === 1 && input.reference === reference &&
    typeof input.runId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.runId), "QA_INPUT_INVALID");
  const actor = input.actor;
  assert(actor?.source === "signed_server_session" && actor.role === "super_admin" &&
    actor.companyId === 1 && typeof actor.email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor.email) && actor.email.length <= 254,
    "QA_VERIFIED_CST_SUPERADMIN_REQUIRED");
  return {
    runId: input.runId,
    actor: { source: "signed_server_session", role: "super_admin", companyId: 1, email: actor.email },
  };
}

async function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const result = await cleanupPo14WorkerDatabase({ databaseName, created,
      bootstrap, client, pool, pooledClients: isolatedWorkerPoolClients });
    removed = result.removed;
  })();
  return cleanupPromise;
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    cancelled = true;
    void cleanup().catch(() => undefined).finally(() => process.exit(signal === "SIGTERM" ? 143 : 130));
  });
}

async function transaction<T>(work: () => Promise<T>): Promise<T> {
  assert(client, "QA_CLIENT_NOT_READY");
  await client.query("begin");
  try { const result = await work(); await client.query("commit"); return result; }
  catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
}

async function snapshot() {
  const result = await client!.query(`select
    (select count(*)::int from public.bank_mutations) mutations,
    (select count(*)::int from public.accounting_entries) journals,
    (select count(*)::int from public.accounting_entry_lines) lines,
    (select count(*)::int from public.payment_allocations) allocations,
    (select count(*)::int from public.payment_matching_groups) groups,
    (select count(*)::int from public.bank_reconciliation_audit) bank_audits,
    (select count(*)::int from public.mkt_payment_approval_audit_dev) approval_audits,
    (select count(*)::int from public.audit_logs) finalization_audits`);
  return result.rows[0];
}

async function execute() {
  const { actor, runId } = await readInput();
  // The parent passes a clean, literal environment. These local flags enable
  // only service branches inside this separate, disposable process.
  process.env.APP_ENV = "development";
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "false";
  process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV = "false";
  process.env.BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV = "true";
  stage("create_disposable_database");
  bootstrap = new pg.Client({ connectionString: bootstrapUrl, application_name: "po14-qa-worker-bootstrap",
    connectionTimeoutMillis: 4000, query_timeout: 5500, statement_timeout: 5000 });
  await bootstrap.connect();
  const exists = await bootstrap.query("select 1 from pg_database where datname=$1", [databaseName]);
  assert(exists.rows.length === 0, "QA_DATABASE_ALREADY_EXISTS");
  // Mark the verified-absent, generated name before CREATE so cancellation
  // during CREATE still queues cleanup for this exact database.
  created = true;
  await bootstrap.query(`create database "${databaseName}"`);
  assert(!cancelled, "QA_CANCELLED");
  client = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:55495/${databaseName}`,
    application_name: "po14-qa-worker-evidence", connectionTimeoutMillis: 4000,
    query_timeout: 10000, statement_timeout: 10000 });
  await client.connect();
  for (const ddl of [marketplaceSchema, bankSchema, ingestionSchema]) await client.query(ddl);
  await client.query(`
    create table public.qa_worker_activity(id serial primary key,action text,payload jsonb);
    create table public.qa_worker_notification_intents(id serial primary key,event_type text,state text);
    create table public.qa_worker_sheet_updates(id serial primary key,payload jsonb);
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
      values(11,1,'QA-BANK-11','Bank QA',302,true,'bank');
    insert into public.bank_sheet_configs
      (id,company_id,sheet_id,tab_name,label,bank_account_id,bank_account_number,is_active)
      values(1,1,'QA-LOCAL-PO14','mutasidev','PO14 isolated',11,'QA-BANK-11',true);
    insert into public.accounting_journals(id,company_id,name,code,type)
      values(1,1,'Bank QA','BANK','bank');
    insert into public.accounting_settings(company_id,bank_journal_id,ap_account_id)
      values(1,1,301);
  `);
  assert(!cancelled, "QA_CANCELLED");
  configureIsolatedWorkerDatabase(databaseName);

  stage("invoice_and_three_way_matching");
  const vendor = { actorType: "vendor" as const, actorId: "QA-PO14" };
  const createdInvoice = await createMarketplaceVendorInvoice({
    poId: 14, grId: 6, vendorInvoiceRef: "QA-PO14-INTERNAL-TEST-ONLY",
    invoiceDate: new Date("2026-11-25T00:00:00Z"), currency: "IDR",
    totalAmount: 100000, taxAmount: 0, grandTotal: 100000,
    supplierId: 24, supplierName: "PT Cahaya Sejati Teknologi", companyId: 1,
    lines: [{ poLineId: 14, quantity: 1, unitPrice: 100000, subtotal: 100000, name: "Frozen Tuna Saku", unit: "pcs" }],
    attachment: { objectPath: "isolated/qa-po14/TEST-ONLY.pdf", fileName: "TEST-ONLY.pdf", contentType: "application/pdf", size: 27 },
  }, vendor, db);
  assert(createdInvoice.ok, "QA_INVOICE_CREATE_FAILED");
  const invoiceId = createdInvoice.invoice.id;
  const matchedInvoice = await submitMarketplaceVendorInvoice(invoiceId, vendor, db);
  assert(matchedInvoice.ok && matchedInvoice.invoice.status === "ready_for_ap" &&
    matchedInvoice.invoice.threeWayMatchStatus === "passed", "QA_THREE_WAY_MATCH_FAILED");

  stage("ap_and_payment_request");
  const financeActor = { actorId: actor.email, actorName: "Verified CST Super Admin" };
  const ap = await createApPreparation(invoiceId, financeActor, db);
  assert(ap.ok, "QA_AP_CREATE_FAILED");
  const apId = ap.preparation.id;
  assert((await reviewApPreparation(apId, financeActor, db)).ok, "QA_FINANCE_REVIEW_FAILED");
  const waiting = await markApPreparationWaitingPayment(apId, financeActor, db);
  assert(waiting.ok && waiting.preparation.status === "waiting_payment", "QA_AP_WAITING_PAYMENT_FAILED");
  const handoff = await createMarketplaceAccountingHandoff(apId, financeActor, db);
  assert(handoff.ok, "QA_HANDOFF_FAILED");
  const requestId = handoff.paymentRequestId;
  const handoffId = handoff.handoffId;
  const dialect = new PgDialect();
  const approvalDb = { execute: async (statement: any) => {
    const query = dialect.sqlToQuery(statement);
    return client!.query(query.sql, query.params);
  } };
  const approved = await transaction(() => approveMarketplacePaymentRequest(approvalDb, actor, requestId));
  assert(approved.status === "approved" && approved.replay === false, "QA_APPROVAL_FAILED");
  const approvalReplay = await transaction(() => approveMarketplacePaymentRequest(approvalDb, actor, requestId));
  assert(approvalReplay.replay, "QA_APPROVAL_REPLAY_FAILED");

  stage("bank_sheet_import");
  const imported = await syncOneBankSheetConfig(1);
  assert(imported.ok && imported.imported === 1 && imported.existing === 0, "QA_IMPORT_FAILED");
  const mutations = await client.query("select * from public.bank_mutations order by id");
  assert(mutations.rows.length === 1, "QA_IMPORT_COUNT_INVALID");
  const mutation = mutations.rows[0];
  assert(mutation.source === "google_sheet" && mutation.status === "unmatched" &&
    mutation.journal_entry_id === null && mutation.import_row_id === null &&
    mutation.import_batch_id === null && mutation.company_id === 1 &&
    Number(mutation.amount) === 100000 && mutation.direction === "OUT", "QA_IMPORTED_MUTATION_INVALID");
  const mutationId = Number(mutation.id);
  const importReplay = await syncOneBankSheetConfig(1);
  assert(importReplay.imported === 0 && importReplay.existing === 1, "QA_IMPORT_REPLAY_FAILED");

  stage("automatic_matching");
  const matchingStatus = await transaction(() => matchLocalMutation(client!, mutation, actor, actor));
  assert(matchingStatus === "matched", "QA_AUTOMATIC_MATCH_FAILED");
  const candidates = await client.query(`select id,candidate_id,status from public.bank_reconciliation_matches
    where mutation_id=$1 and candidate_type='vendor_invoice'`, [mutationId]);
  assert(candidates.rows.length === 1 && Number(candidates.rows[0].candidate_id) === invoiceId &&
    candidates.rows[0].status === "candidate", "QA_CANDIDATE_EVIDENCE_INVALID");

  stage("allocation_rollback");
  const beforeFault = await snapshot();
  await client.query(`create function public.qa_fail_allocation_audit() returns trigger language plpgsql as $$
    begin if new.action='MATCH_APPROVED' then raise exception 'PO14_QA_AUDIT_FAILURE'; end if; return new; end $$;
    create trigger qa_fail_bank_audit before insert on public.bank_reconciliation_audit
      for each row execute function public.qa_fail_allocation_audit()`);
  let expectedFault = false;
  try { await allocateVendorInvoiceBankBatch(client, actor, 1, mutationId, [invoiceId], new Map(), actor); }
  catch (error) { expectedFault = error instanceof Error && error.message.includes("PO14_QA_AUDIT_FAILURE"); }
  assert(expectedFault, "QA_AUDIT_FAULT_NOT_OBSERVED");
  assert(JSON.stringify(await snapshot()) === JSON.stringify(beforeFault), "QA_AUDIT_ROLLBACK_FAILED");
  const afterFault = await client.query("select status,journal_entry_id from public.bank_mutations where id=$1", [mutationId]);
  assert(afterFault.rows[0]?.status === "matched" && afterFault.rows[0]?.journal_entry_id === null,
    "QA_AUDIT_ROLLBACK_MUTATION_CHANGED");
  await client.query("drop trigger qa_fail_bank_audit on public.bank_reconciliation_audit; drop function public.qa_fail_allocation_audit()");

  stage("allocation_and_canonical_posting");
  const allocation = await allocateVendorInvoiceBankBatch(client, actor, 1, mutationId, [invoiceId], new Map(), actor);
  assert(allocation.ok && allocation.status === "approved_pending_posting", "QA_ALLOCATION_FAILED");
  const journalId = allocation.journal_entry_id;
  const groupId = allocation.payment_matching_group_id;
  const approvedMatches = await client.query(`select id from public.bank_reconciliation_matches
    where mutation_id=$1 and candidate_type='vendor_invoice' and candidate_id=$2 and status='approved'`, [mutationId, invoiceId]);
  assert(approvedMatches.rows.length === 1, "QA_APPROVED_MATCH_INVALID");
  const matchId = Number(approvedMatches.rows[0].id);
  const allocated = await client.query("select id from public.payment_allocations where mutation_id=$1 and invoice_id=$2 and is_active=true", [mutationId, invoiceId]);
  assert(allocated.rows.length === 1, "QA_NATIVE_ALLOCATION_INVALID");
  const allocationId = Number(allocated.rows[0].id);
  const posted = await transaction(() => postBankMutationCanonical(client!, mutationId, journalId, matchId, actor, { reason: "PO14 isolated service QA" }));
  assert(posted.status === "posted" && posted.idempotent === false, "QA_POSTING_FAILED");
  const finalized = await finalizePostedMarketplacePayment(client, actor, requestId, mutationId);
  assert(finalized.status === "CONFIRMED", "QA_FINALIZATION_FAILED");

  stage("replay_and_sql_evidence");
  const beforeReplay = await snapshot();
  const replayImport = await syncOneBankSheetConfig(1);
  const replayPost = await transaction(() => postBankMutationCanonical(client!, mutationId, journalId, matchId, actor, { reason: "PO14 isolated replay" }));
  const replayFinalization = await finalizePostedMarketplacePayment(client, actor, requestId, mutationId);
  assert(replayImport.imported === 0 && replayImport.existing === 1 && replayPost.idempotent &&
    replayFinalization.status === "REPLAY", "QA_REPLAY_FAILED");
  assert(JSON.stringify(await snapshot()) === JSON.stringify(beforeReplay), "QA_REPLAY_CHANGED_EVIDENCE");
  await flushQaPostCommitCallbacks();
  await flushSuppressedNotificationIntents();
  const evidence = await client.query(`select
    vi.status::text invoice_status,vi.three_way_match_status,
    ap.status::text ap_status,pr.status::text payment_status,pr.paid_amount::numeric(14,2)::text paid,
    h.accounting_status,b.status bank_status,b.accounting_posted,b.reconciliation_status,
    ae.status journal_status,ae.total_debit::numeric(14,2)::text debit,ae.total_credit::numeric(14,2)::text credit,
    (select sum(debit)::numeric(14,2)::text from public.accounting_entry_lines where entry_id=ae.id) line_debit,
    (select sum(credit)::numeric(14,2)::text from public.accounting_entry_lines where entry_id=ae.id) line_credit,
    (select count(*)::int from public.mkt_payment_approval_audit_dev) approval_audits,
    (select count(*)::int from public.bank_reconciliation_audit where action='CANONICAL_POSTED') posting_audits,
    (select count(*)::int from public.audit_logs where action='marketplace_ap_bank_finalized') finalization_audits,
    (select count(*)::int from public.qa_worker_notification_intents where state='suppressed') suppressed_notifications
    from public.payment_requests pr join public.mkt_ap_preparations ap on ap.id=pr.mkt_ap_preparation_id
    join public.vendor_invoices vi on vi.id=ap.vendor_invoice_id
    join public.mkt_accounting_handoffs h on h.payment_request_id=pr.id
    join public.bank_mutations b on b.id=$2
    join public.accounting_entries ae on ae.id=b.journal_entry_id
    where pr.id=$1`, [requestId, mutationId]);
  assert(evidence.rows.length === 1, "QA_FINAL_EVIDENCE_MISSING");
  const row = evidence.rows[0];
  assert(row.invoice_status === "ready_for_ap" && row.three_way_match_status === "passed" &&
    row.ap_status === "waiting_payment" && row.payment_status === "paid" && row.paid === "100000.00" &&
    row.accounting_status === "posted" && row.bank_status === "posted" && row.accounting_posted === true &&
    row.reconciliation_status === "reconciled" && row.journal_status === "posted" &&
    row.debit === "100000.00" && row.credit === "100000.00" && row.line_debit === row.debit && row.line_credit === row.credit &&
    row.approval_audits === 1 && row.posting_audits === 1 && row.finalization_audits === 1,
    "QA_FINAL_EVIDENCE_INVALID");
  const entities = { invoiceId, apId, requestId, handoffId, mutationId, matchId, groupId, allocationId, journalId };
  assert(Object.values(entities).every(positiveId), "QA_ENTITY_IDS_INVALID");
  stage("cleanup");
  await cleanup();
  assert(removed, "QA_DATABASE_NOT_REMOVED");
  return {
    ok: true, contract: "po14-real-sql-v1", reference, runId,
    actor: { email: actor.email, companyId: 1 }, entities,
    totals: { debit: row.debit, credit: row.credit },
    checks: { invoiceCreated: true, threeWayMatched: true, apPrepared: true, paymentApproved: true,
      bankImported: true, automaticMatched: true, allocationCreated: true, journalPosted: true,
      paymentFinalized: true, replayIdempotent: true, auditRollback: true },
    auditCounts: { approval: row.approval_audits, bank: row.posting_audits, finalization: row.finalization_audits },
    isolatedDatabase: { name: databaseName, removed }, outboundNotifications: 0,
    suppressedNotifications: row.suppressed_notifications,
    sheetTransport: "synthetic_fixture", businessDatabaseUsed: false, realBankTransfer: false,
  };
}

try {
  const result = await execute();
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  let cleanupFailed = false;
  try { await cleanup(); } catch { cleanupFailed = true; }
  const message = error instanceof Error ? error.message : "QA_WORKER_FAILED";
  const code = /^[A-Z][A-Z0-9_]{3,90}$/.test(message) ? message : "QA_SQL_EXECUTION_FAILED";
  process.stdout.write(JSON.stringify({ ok: false, contract: "po14-real-sql-v1", code, stage: currentStage,
    isolatedDatabase: { name: databaseName, removed: !created || removed }, cleanupFailed }) + "\n");
  process.exitCode = 1;
}
