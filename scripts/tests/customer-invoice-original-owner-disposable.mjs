import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Pool } = pg;
const target = process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL;
const moduleFile = process.env.CUSTOMER_INVOICE_DISPOSABLE_OWNER_PATH;
assert.equal(process.env.APP_ENV, "development");
assert.equal(process.env.NODE_ENV, "development");
assert.equal(process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV, "true");
assert.equal(process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV, "true");
assert(target && moduleFile, "explicit disposable URL and owner module are required");
const parsed = new URL(target);
assert.equal(parsed.hostname, "127.0.0.1", "localhost-only fixture");
assert.equal(parsed.pathname, "/invoice_synthetic", "disposable database only");
assert(moduleFile.endsWith("/portalInvoiceAdapter.mjs"), "bundled original owner only");

const { postCustomerInvoiceWithOriginalOwner } = await import(pathToFileURL(moduleFile).href);
assert.equal(typeof postCustomerInvoiceWithOriginalOwner, "function");
const pool = new Pool({ connectionString: target, max: 2, connectionTimeoutMillis: 2000 });

async function counts(sourceId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM accounting_entries WHERE source='sales_invoice' AND source_id=$1",
    [sourceId],
  );
  return Number(rows[0].n);
}
async function assertReceipt(companyId, sourceId, { rollback = false, expectedFailure = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      "UPDATE sales_documents SET updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING id,company_id,invoice_number,grand_total",
      [sourceId, companyId],
    );
    assert.equal(updated.rowCount, 1, "one source row locked");
    const invoice = updated.rows[0];
    const action = () => postCustomerInvoiceWithOriginalOwner({
      query: (sql, values) => client.query(sql, values),
      transactionClient: client,
      companyId,
      source: "sales_invoice",
      sourceId,
      invoice,
      actorId: "synthetic-owner",
    });
    if (expectedFailure) {
      await assert.rejects(action, expectedFailure);
      await client.query("ROLLBACK");
      console.log("TAXABLE_INVOICE_FAIL_CLOSED_PASS", companyId, sourceId);
      return;
    }
    const receipt = await action();
    assert.equal(receipt.posted, true);
    assert(Number.isSafeInteger(receipt.entryId) && receipt.entryId > 0);
    if (rollback) {
      await client.query("ROLLBACK");
      console.log("OWNER_ROLLBACK_ACTION_PASS", companyId, sourceId);
      return;
    }
    await client.query("COMMIT");
    console.log("ORIGINAL_OWNER_COMMIT_PASS", companyId, sourceId, receipt.entryId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function verifyPosted(companyId, sourceId, { gross = 100, tax = 0 } = {}) {
  const entry = await pool.query(
    "SELECT id,status::text,total_debit,total_credit FROM accounting_entries WHERE company_id=$1 AND source='sales_invoice' AND source_id=$2",
    [companyId, sourceId],
  );
  assert.equal(entry.rows.length, 1);
  assert.equal(entry.rows[0].status, "posted");
  assert.equal(Number(entry.rows[0].total_debit), gross);
  assert.equal(Number(entry.rows[0].total_credit), gross);
  const entryId = Number(entry.rows[0].id);
  const lines = await pool.query(
    "SELECT COALESCE(SUM(debit),0) AS debit,COALESCE(SUM(credit),0) AS credit,COUNT(*)::int AS n FROM accounting_entry_lines WHERE entry_id=$1",
    [entryId],
  );
  assert.equal(Number(lines.rows[0].n), tax ? 3 : 2);
  assert.equal(Number(lines.rows[0].debit), gross);
  assert.equal(Number(lines.rows[0].credit), gross);
  for (const table of ["ledger_events", "financial_outbox_events"]) {
    const results = await pool.query("SELECT COUNT(*)::int AS n FROM " + table + " WHERE company_id=$1 AND entry_id=$2", [companyId, entryId]);
    assert.equal(Number(results.rows[0].n), 1, table + " should be once per source");
  }
  const ar = await pool.query(
    "SELECT company_id,invoice_id,gl_entry_id,gross_amount,outstanding_amount,paid_amount,status,notes FROM public.ar_subledger WHERE company_id=$1 AND invoice_id=$2",
    [companyId, sourceId],
  );
  assert.equal(ar.rows.length, 1, "exactly one original reviewed AR projection");
  assert.equal(Number(ar.rows[0].gl_entry_id), entryId);
  assert.equal(Number(ar.rows[0].gross_amount), gross);
  assert.equal(Number(ar.rows[0].outstanding_amount), gross);
  assert.equal(Number(ar.rows[0].paid_amount), 0);
  assert.equal(ar.rows[0].status, "OPEN");
  assert.equal(ar.rows[0].notes, "bizportal:customer-ar-source:v1");
  const taxRows = await pool.query(
    "SELECT tax_id,tax_rate,base_amount,tax_amount,account_id,status,direction FROM public.transaction_taxes WHERE company_id=$1 AND transaction_type='sales_invoice' AND transaction_id=$2",
    [companyId,sourceId],
  );
  assert.equal(taxRows.rows.length,tax ? 1 : 0);
  if(tax) {
    assert.equal(Number(taxRows.rows[0].tax_amount),tax);
    assert.equal(Number(taxRows.rows[0].base_amount),gross-tax);
    assert.equal(Number(taxRows.rows[0].tax_rate),11);
    assert.equal(taxRows.rows[0].status,"posted");
    assert.equal(taxRows.rows[0].direction,"output");
    console.log("ATOMIC_OUTPUT_PPN_RECORD_PASS",companyId,sourceId);
  }
  console.log("POST_COMMIT_GL_AND_ORIGINAL_AR_PASS", companyId, sourceId);
  console.log("POST_COMMIT_BALANCED_AUDIT_OUTBOX_PASS", companyId, sourceId);
}
try {
  await assertReceipt(1, 171);
  await assertReceipt(3, 173);
  await verifyPosted(1, 171);
  await verifyPosted(3, 173);
  await assertReceipt(1, 171);
  await assertReceipt(3, 173);
  assert.equal(await counts(171), 1);
  assert.equal(await counts(173), 1);
  await verifyPosted(1, 171);
  await verifyPosted(3, 173);
  console.log("IDEMPOTENT_REPLAY_PASS");
  await assertReceipt(1, 175, { rollback: true });
  assert.equal(await counts(175), 0);
  const rbAr = await pool.query("SELECT COUNT(*)::int AS n FROM public.ar_subledger WHERE invoice_id=175");
  assert.equal(Number(rbAr.rows[0].n), 0);
  console.log("ROLLBACK_LEAVES_NO_JOURNAL_OR_AR_PASS");
  await assertReceipt(1, 179);
  await assertReceipt(3, 183);
  await verifyPosted(1,179,{gross:111,tax:11});
  await verifyPosted(3,183,{gross:111,tax:11});
  await assertReceipt(1,179);
  await assertReceipt(3,183);
  assert.equal(await counts(179),1);
  assert.equal(await counts(183),1);
  await verifyPosted(1,179,{gross:111,tax:11});
  await verifyPosted(3,183,{gross:111,tax:11});
  console.log("ATOMIC_PPN_AND_REPLAY_PASS");
  await assertReceipt(1, 177, { expectedFailure: /TAX_OR_ADJUSTMENT_UNSUPPORTED/ });
  await assertReceipt(1, 185, { expectedFailure: /TAX_CONFIGURATION_OR_AMOUNT_MISMATCH/ });
  for(const sourceId of [177,185]){
    assert.equal(await counts(sourceId),0);
    const taxAr = await pool.query("SELECT COUNT(*)::int AS n FROM public.ar_subledger WHERE invoice_id=$1",[sourceId]);
    assert.equal(Number(taxAr.rows[0].n), 0);
    const taxRow = await pool.query("SELECT COUNT(*)::int AS n FROM public.transaction_taxes WHERE transaction_type='sales_invoice' AND transaction_id=$1",[sourceId]);
    assert.equal(Number(taxRow.rows[0].n),0);
  }
  console.log("INVALID_PPN_REJECTION_LEAVES_NO_JOURNAL_TAX_OR_AR_PASS");
} finally {
  await pool.end();
}
