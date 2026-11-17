import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { CUSTOMER_AR_SOURCE_EVIDENCE_SQL, CUSTOMER_AR_INVOICES_SQL } from "../../artifacts/api-server/src/lib/reconciliation/customerArSourceSql";
import { buildCustomerArMatchPreview } from "../../artifacts/api-server/src/lib/reconciliation/customerArMatchPreview";

const url = process.env.CUSTOMER_AR_DISPOSABLE_ADMIN_URL ?? "";
const target = new URL(url);
assert.equal(process.env.CUSTOMER_AR_DISPOSABLE_INTEGRATION, "true");
assert.equal(target.hostname, "customerarpg");
assert.equal(target.pathname, "/cst_customer_ar_ci");
const admin = new pg.Client({ connectionString: url });
const clients: pg.Client[] = [admin];
let passed = 0;
let postgresMajor = 0;
const check = (name: string) => { passed += 1; console.log(`PASS ${name}`); };
const sqlFile = (name: string) => readFileSync(`scripts/sql/${name}`, "utf8");
const marker = "bizportal:customer-ar-source:v1";
async function connect(user = "postgres", password = "synthetic-admin-only") {
  const connection = new URL(url); connection.username = user; connection.password = password;
  const client = new pg.Client({ connectionString: connection.toString() });
  await client.connect(); clients.push(client); return client;
}
async function transaction(client: pg.Client, run: () => Promise<void>) {
  await client.query("BEGIN");
  try { await run(); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}
async function document(client: pg.Client, id: number, company = 1, overrides: Record<string, unknown> = {}) {
  const row = { id, company_id: company, invoice_number: `INV-CI-${id}`,
    invoice_date: "2026-11-17", due_date: "2026-12-17", ...overrides };
  const columns = Object.keys(row);
  assert(columns.every((column) => /^[a-z_]+$/.test(column)));
  await client.query(`insert into public.sales_documents (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
}
async function header(client: pg.Client, id: number, invoice = id, company = 1, overrides: Record<string, unknown> = {}) {
  const row = { id, company_id: company, source: "sales_invoice", source_id: invoice,
    journal_id: company * 10 + 1, ...overrides };
  const columns = Object.keys(row);
  assert(columns.every((column) => /^[a-z_]+$/.test(column)));
  await client.query(`insert into public.accounting_entries (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
}
async function lines(client: pg.Client, id: number, company = 1, amount = 100, explicitCompany: number | null = null) {
  await client.query("insert into public.accounting_entry_lines(entry_id,company_id,account_id,debit,credit) values ($1,$2,$3,$5,0),($1,$2,$4,0,$5)",
    [id, explicitCompany, company * 100 + 1, company * 100 + 2, amount]);
}
async function issue(client: pg.Client, id: number, company = 1, doc: Record<string, unknown> = {}, entry: Record<string, unknown> = {}) {
  await transaction(client, async () => {
    await document(client, id, company, doc);
    await header(client, id, id, company, entry);
    // This mirrors the owner writing a posted header before its final lines.
    assert.equal((await client.query("select count(*)::int n from public.ar_subledger where company_id=$1 and invoice_id=$2", [company, id])).rows[0].n, 0);
    await lines(client, id, company);
  });
}
async function ar(id: number) {
  return (await admin.query("select * from public.ar_subledger where invoice_id=$1", [id])).rows;
}
async function preview(client: pg.Client, id: number, company = 1) {
  const { rows } = await client.query(CUSTOMER_AR_INVOICES_SQL, [company]);
  return rows.find((row) => row.id === id);
}
async function absent(id: number, label: string) {
  assert.equal((await ar(id)).length, 0, label);
  const evidence = await preview(admin, id);
  if (evidence) assert.equal(evidence.ar_journal_posted, false, label);
}
async function denied(client: pg.Client, statement: string, params: unknown[] = []) {
  let code: string | undefined;
  try { await client.query(statement, params); } catch (error) { code = (error as { code?: string }).code; }
  assert.equal(code, "42501");
}

async function main() {
  await admin.connect();
  const version = Number((await admin.query("show server_version_num")).rows[0].server_version_num);
  postgresMajor = Math.floor(version / 10000);
  assert([16, 17].includes(postgresMajor));
  assert.equal(String(postgresMajor), process.env.CUSTOMER_AR_EXPECTED_PG_MAJOR);
  await admin.query(readFileSync("scripts/tests/customer-ar-source-synthetic-baseline.sql", "utf8"));
  const install = sqlFile("customer_ar_source_dev_INSTALL_REVIEW.sql");
  const viewBody = install.split("WITH (security_invoker = true, security_barrier = true) AS\n")[1]!.split(";\n-- END SHARED SOURCE EVIDENCE")[0]!.trim();
  assert.equal(viewBody, CUSTOMER_AR_SOURCE_EVIDENCE_SQL.trim());
  const baseline = (await admin.query("select row_to_json(ar_subledger) data from public.ar_subledger where invoice_id=901")).rows[0].data;
  const immutable = JSON.stringify((await admin.query("select jsonb_build_object('bank',(select jsonb_agg(b) from public.bank_mutations b),'payment',(select jsonb_agg(p) from public.payments p)) data")).rows[0].data);
  await admin.query(install);
  assert.equal((await admin.query("select count(*)::int n from public.ar_subledger")).rows[0].n, 1);
  assert.equal((await admin.query("select count(*)::int n from public.bizportal_customer_ar_source_actors_dev where enabled")).rows[0].n, 0);
  const fn = (await admin.query("select prosecdef from pg_proc where proname='bizportal_customer_ar_after_source_dev'")).rows[0];
  assert.equal(fn.prosecdef, false);
  assert.equal((await admin.query("select count(*)::int n from pg_trigger where tgname like 'customer_ar_%_dev' and tgdeferrable and tginitdeferred")).rows[0].n, 3);
  check("install is disabled, invoker, deferred, and does not backfill");

  await issue(admin, 1);
  await absent(1, "default off");
  await admin.query("update public.bizportal_customer_ar_source_actors_dev set enabled=true,source_not_before=clock_timestamp()");
  await admin.query("update public.sales_documents set updated_at=clock_timestamp() where id in(1,900,901)");
  await absent(1, "pre-activation source"); await absent(900, "historical source");
  assert.deepEqual((await admin.query("select row_to_json(ar_subledger) data from public.ar_subledger where invoice_id=901")).rows[0].data, baseline);
  check("activation does not backfill old sources or overwrite another AR owner");

  await issue(admin, 10);
  let row = (await ar(10))[0]; assert.equal(row.gl_entry_id, 10); assert.equal(row.notes, marker);
  assert.equal(row.outstanding_amount, "100.00"); assert.equal(row.paid_amount, "0.00");
  assert.equal((await preview(admin, 10)).ar_journal_posted, true);
  assert.equal((await admin.query("select count(*)::int n from public.accounting_entries where source_id=10")).rows[0].n, 1);
  check("posted-header-before-lines produces one proven AR only after commit");

  await document(admin, 11); await absent(11, "invoice first");
  await transaction(admin, async () => { await header(admin, 11); await lines(admin, 11); });
  assert.equal((await ar(11)).length, 1);
  await transaction(admin, async () => { await header(admin, 12); await lines(admin, 12); });
  await document(admin, 12); assert.equal((await ar(12)).length, 1);
  await document(admin, 13); await header(admin, 13); await absent(13, "missing lines");
  await lines(admin, 13); assert.equal((await ar(13)).length, 1);
  check("invoice-first, journal-first, and later-line commits converge automatically");

  await issue(admin, 20, 1, {}, { status: "draft" }); await absent(20, "unposted");
  await issue(admin, 21, 1, {}, { is_voided: true }); await absent(21, "void");
  await issue(admin, 22, 1, {}, { is_reversed: true }); await absent(22, "reversed flag");
  await issue(admin, 23, 1, {}, { source: "manual" }); await absent(23, "wrong source");
  await issue(admin, 24, 1, {}, { total_credit: 99 }); await absent(24, "header mismatch");
  await issue(admin, 25, 1, { invoice_number: null }); await absent(25, "missing number");
  await issue(admin, 26, 1, { invoice_date: null }); await absent(26, "missing date");
  await issue(admin, 27, 1, { due_date: "2026-11-01" }); await absent(27, "bad due date");
  await issue(admin, 28, 1, { status: "draft" }); await absent(28, "draft invoice");
  await issue(admin, 29, 1, { cancelled_at: "2026-11-17" }); await absent(29, "cancelled at");
  check("missing metadata, unposted, void, reversal flags, wrong owner and inconsistent totals reject");

  await transaction(admin, async () => { await document(admin, 30); await header(admin, 30); await lines(admin, 30, 1, 90); });
  await absent(30, "line amount mismatch");
  await transaction(admin, async () => { await document(admin, 31); await header(admin, 31); await lines(admin, 31, 1, 100, 3); });
  await absent(31, "explicit foreign line company");
  await transaction(admin, async () => { await document(admin, 32); await header(admin, 32); await lines(admin, 32, 3); });
  await absent(32, "foreign chart accounts");
  await transaction(admin, async () => { await document(admin, 33); await header(admin, 33, 33, 3); await lines(admin, 33, 3); });
  await absent(33, "foreign header");
  await issue(admin, 34, 1, {}, { journal_id: 31 }); await absent(34, "foreign journal");
  await transaction(admin, async () => {
    await document(admin, 35); await header(admin, 35);
    await admin.query("insert into public.accounting_entry_lines(entry_id,account_id,debit,credit) values (35,102,100,0),(35,103,0,100)");
  }); await absent(35, "balanced journal without AR debit");
  check("strict header, journal, all lines, account company and mapped AR debit proof");

  await admin.query("drop index public.accounting_entries_source_idx");
  await transaction(admin, async () => {
    await document(admin, 36); await header(admin, 36); await lines(admin, 36);
    await header(admin, 1036, 36); await lines(admin, 1036);
  }); await absent(36, "ambiguous source");
  await admin.query("delete from public.accounting_entry_lines where entry_id=1036");
  await admin.query("delete from public.accounting_entries where id=1036");
  await admin.query("create unique index accounting_entries_source_idx on public.accounting_entries(company_id,source,source_id) where source is not null and source_id is not null and source <> 'manual'");
  await transaction(admin, async () => {
    await document(admin, 37, 1, { invoice_number: "INV-DUPLICATE" }); await header(admin, 37); await lines(admin, 37);
    await document(admin, 38, 1, { invoice_number: " inv-duplicate " }); await header(admin, 38); await lines(admin, 38);
  }); await absent(37, "duplicate invoice reference"); await absent(38, "duplicate invoice reference");
  check("ambiguous GL sources and normalized invoice numbers fail closed");

  const beforeReplay = (await ar(10))[0];
  for (let n = 0; n < 3; n++) await admin.query("update public.sales_documents set updated_at=clock_timestamp() where id=10");
  assert.deepEqual((await ar(10))[0], beforeReplay);
  await admin.query("update public.sales_documents set amount_paid=20,payment_status='partial' where id=10");
  for (let n = 0; n < 3; n++) await admin.query("update public.sales_documents set updated_at=clock_timestamp() where id=10");
  row = (await ar(10))[0]; assert.equal(row.paid_amount, "20.00"); assert.equal(row.outstanding_amount, "80.00");
  await admin.query("update public.sales_documents set amount_paid=30 where id=10");
  row = (await ar(10))[0]; assert.equal(row.paid_amount, "30.00"); assert.equal(row.outstanding_amount, "70.00");
  assert.equal(row.id, beforeReplay.id); assert.equal(row.gl_entry_id, beforeReplay.gl_entry_id);
  check("partial balance is absolute; source replay never adds payment twice");

  const invoice = await preview(admin, 10);
  const evidence = [{ id: invoice.id, companyId: invoice.company_id, invoiceNumber: invoice.invoice_number,
    customerName: invoice.customer_name, invoiceStatus: invoice.invoice_status, documentStatus: invoice.document_status,
    paymentStatus: invoice.payment_status, outstandingAmount: Number(invoice.outstanding_amount), arJournalPosted: invoice.ar_journal_posted }];
  const mutation = (amount: number) => [{ id: 90, companyId: 1, direction: "IN", status: "unmatched", amount,
    description: "Payment INV-CI-10", bankReference: null, providerOrderId: null }];
  assert.equal(buildCustomerArMatchPreview(evidence, mutation(70))[0].status, "candidate_ready_for_review");
  assert.equal(buildCustomerArMatchPreview(evidence, mutation(20))[0].status, "partial_payment_review");
  assert.equal(buildCustomerArMatchPreview(evidence, mutation(90))[0].status, "overpayment_review");
  await admin.query("update public.sales_documents set amount_paid=101 where id=10");
  assert.equal((await ar(10))[0].status, "STALE"); assert.equal((await preview(admin, 10)).ar_journal_posted, false);
  await admin.query("update public.sales_documents set amount_paid=-1 where id=10");
  assert.equal((await preview(admin, 10)).ar_journal_posted, false);
  await admin.query("update public.sales_documents set amount_paid=100,payment_status='paid' where id=10");
  row = (await ar(10))[0]; assert.equal(row.status, "PAID"); assert.equal(row.outstanding_amount, "0.00");
  check("exact/partial/overpayment preview, invalid paid values and fully paid state");

  await issue(admin, 40);
  await transaction(admin, async () => { await header(admin, 1040, 40, 3, { source: "reversal" }); await lines(admin, 1040, 3); });
  assert.equal((await preview(admin, 40)).ar_journal_posted, true);
  await transaction(admin, async () => { await header(admin, 2040, 40, 1, { source: "reversal" }); await lines(admin, 2040); });
  assert.equal((await ar(40))[0].status, "STALE"); assert.equal((await preview(admin, 40)).ar_journal_posted, false);
  await transaction(admin, async () => { await document(admin, 42); await header(admin, 142, 42); await lines(admin, 142); });
  assert.equal((await ar(42))[0].gl_entry_id, 142);
  await transaction(admin, async () => { await header(admin, 942, 142, 1, { source: "reversal" }); await lines(admin, 942); });
  assert.equal((await ar(42))[0].status, "STALE"); assert.equal((await preview(admin, 42)).ar_journal_posted, false);
  await admin.query("delete from public.accounting_entries where id=942");
  assert.equal((await ar(42))[0].status, "OPEN"); assert.equal((await preview(admin, 42)).ar_journal_posted, true);
  await transaction(admin, async () => { await document(admin, 43); await header(admin, 143, 43); await lines(admin, 143); });
  await transaction(admin, async () => { await header(admin, 943, 43, 1, { source: "reversal" }); await lines(admin, 943); });
  assert.equal((await ar(43))[0].status, "STALE"); assert.equal((await preview(admin, 43)).ar_journal_posted, false);
  await admin.query("update public.sales_documents set status='cancelled' where id=11");
  assert.equal((await ar(11))[0].status, "STALE");
  await admin.query("update public.sales_documents set status='cancelled' where id=901");
  assert.deepEqual((await admin.query("select row_to_json(ar_subledger) data from public.ar_subledger where invoice_id=901")).rows[0].data, baseline);
  check("reversal/cancel stales only owned AR; foreign reversal and unrelated AR stay unchanged");

  await issue(admin, 50, 3); await issue(admin, 51, 2); await absent(51, "unapproved issuer company");
  const cst = await connect("bizportal_finance_cst_login_dev", "synthetic-cst-only");
  const diva = await connect("bizportal_finance_diva_login_dev", "synthetic-diva-only");
  assert.equal((await cst.query("select current_user,session_user")).rows[0].current_user, "bizportal_finance_cst_login_dev");
  assert.equal((await cst.query("select count(*)::int n from public.sales_documents where company_id<>1")).rows[0].n, 0);
  assert.equal((await diva.query("select count(*)::int n from public.sales_documents where company_id<>3")).rows[0].n, 0);
  assert.equal((await preview(cst, 12)).ar_journal_posted, true);
  assert.equal((await preview(diva, 50, 3)).ar_journal_posted, true);
  assert.equal((await preview(cst, 31)).ar_journal_posted, false);
  await cst.query("select set_config('app.marketplace_company_id','3',false),set_config('app.company_id','3',false)");
  assert.equal((await cst.query("select count(*)::int n from public.ar_subledger where company_id<>1")).rows[0].n, 0);
  await denied(cst, "update public.bizportal_customer_ar_source_actors_dev set enabled=false");
  await denied(cst, "insert into public.sales_documents(id,company_id) values(9999,1)");
  await denied(cst, "insert into public.accounting_entries(id,company_id,source,source_id,journal_id) values(9999,1,'sales_invoice',9999,11)");
  await denied(cst, "delete from public.ar_subledger");
  await denied(cst, "insert into public.ar_subledger(company_id,invoice_id,notes) values(3,9999,$1)", [marker]);
  await denied(cst, "insert into public.ar_subledger(company_id,invoice_id,notes,gross_amount,outstanding_amount,gl_entry_id) values(1,9999,$1,100,100,50)", [marker]);
  await transaction(admin, async () => {
    await admin.query("set local role bizportal_finance_cst_login_dev");
    assert.equal((await admin.query("select count(*)::int n from public.ar_subledger")).rows[0].n, 0);
  });
  check("real company logins enforce RLS; GUC, SET ROLE, foreign AR and direct GL writes denied");

  // Only this isolated fixture grants source writes, to prove INVOKER behavior
  // when a separately approved issuer uses the existing company role. The
  // release SQL itself grants no source invoice/GL writes or login activation.
  await admin.query(`grant insert,update on public.sales_documents,public.accounting_entries,public.accounting_entry_lines to bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
    grant usage on sequence public.accounting_entry_lines_id_seq to bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
    create policy fixture_source_write on public.sales_documents for all to bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev using(true) with check(true);
    create policy fixture_source_write on public.accounting_entries for all to bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev using(true) with check(true);
    create policy fixture_source_write on public.accounting_entry_lines for all to bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev using(true) with check(true);`);
  await issue(cst, 60); await issue(diva, 61, 3);
  assert.equal((await ar(60))[0].status, "OPEN"); assert.equal((await ar(61))[0].company_id, 3);
  await denied(cst, "insert into public.sales_documents(id,company_id) values(9999,3)");
  await denied(cst, "update public.ar_subledger set outstanding_amount=999 where invoice_id=60");
  let staleTamperCode: string | undefined;
  const beforeStaleTamper = (await ar(60))[0];
  try { await cst.query("update public.ar_subledger set status='STALE',gross_amount=-1,paid_amount=999,customer_id=301,invoice_number='fake' where invoice_id=60"); }
  catch (error) { staleTamperCode = (error as { code?: string }).code; }
  assert.equal(staleTamperCode, "23514"); assert.deepEqual((await ar(60))[0], beforeStaleTamper);
  check("same trigger succeeds with restricted company issuers; broader permissive policies cannot cross tenants");
  check("staling a projection cannot overwrite its financial or identity history");

  await admin.query("revoke insert(company_id,invoice_id,customer_id,invoice_number,invoice_date,due_date,currency,gross_amount,outstanding_amount,paid_amount,status,gl_entry_id,period,notes) on public.ar_subledger from bizportal_finance_cst_login_dev");
  await issue(cst, 62); await absent(62, "missing projection grant");
  await admin.query("grant insert(company_id,invoice_id,customer_id,invoice_number,invoice_date,due_date,currency,gross_amount,outstanding_amount,paid_amount,status,gl_entry_id,period,notes) on public.ar_subledger to bizportal_finance_cst_login_dev");
  await cst.query("update public.sales_documents set updated_at=clock_timestamp() where id=62");
  assert.equal((await ar(62)).length, 1);
  check("accidental projection permission denial does not fail canonical invoice posting; replay recovers");

  await admin.query(`grant select,update on public.accounting_entries to unlisted_issuer_ci;
    create policy fixture_unlisted_issuer on public.accounting_entries for all to unlisted_issuer_ci using(company_id=1) with check(company_id=1)`);
  const unlisted = await connect("unlisted_issuer_ci", "synthetic-unlisted-only");
  await unlisted.query("update public.accounting_entries set is_voided=true where id=60");
  assert.equal((await ar(60))[0].status, "OPEN");
  assert.equal((await preview(admin, 60)).ar_journal_posted, false);
  assert.equal((await preview(cst, 60)).ar_journal_posted, false);
  check("preview independently rejects a source invalidated by an unlisted issuer");
  await admin.query("update public.ar_subledger set customer_id=301 where invoice_id=61");
  assert.equal((await preview(diva, 61, 3)).ar_journal_posted, false);
  await admin.query("update public.ar_subledger set customer_id=null,period='2026-01' where invoice_id=61");
  assert.equal((await preview(diva, 61, 3)).ar_journal_posted, false);
  await admin.query("update public.ar_subledger set period='2026-11' where invoice_id=61");
  assert.equal((await preview(diva, 61, 3)).ar_journal_posted, true);
  check("preview rejects independently changed AR customer and period");

  const a = await connect(); const b = await connect();
  await a.query("BEGIN"); await b.query("BEGIN");
  await document(a, 70); await header(b, 70); await lines(b, 70);
  await Promise.all([a.query("COMMIT"), b.query("COMMIT")]);
  assert.equal((await ar(70)).length, 1); assert.equal((await preview(admin, 70)).ar_journal_posted, true);
  await a.query("BEGIN"); await b.query("BEGIN");
  await header(a, 71); await lines(a, 71); await document(b, 71);
  await Promise.all([b.query("COMMIT"), a.query("COMMIT")]);
  assert.equal((await ar(71)).length, 1);
  await Promise.all([a, b].map(async (connection) => {
    for (let n = 0; n < 4; n++) await connection.query("update public.accounting_entries set total_debit=total_debit where id=70");
  }));
  assert.equal((await ar(70)).length, 1); assert.equal((await ar(70))[0].paid_amount, "0.00");
  check("concurrent invoice/journal commits in both orders and eight replays create exactly one AR");

  await a.query("begin isolation level repeatable read");
  await document(a, 72); await header(a, 72); await lines(a, 72);
  let isolationCode: string | undefined;
  try { await a.query("COMMIT"); } catch (error) { isolationCode = (error as {code?:string}).code; }
  await a.query("ROLLBACK"); assert.equal(isolationCode, "40001"); await absent(72, "stale isolation snapshot");
  check("unsupported isolation requests retry instead of silently losing concurrent linkage");
  await a.query("begin isolation level repeatable read");
  await document(a, 73, 2); await header(a, 73, 73, 2); await lines(a, 73, 2);
  await a.query("COMMIT"); await absent(73, "unrelated company isolation");
  check("unlisted company source events preserve their original transaction isolation behavior");

  const noPayments = JSON.stringify((await admin.query("select jsonb_build_object('bank',(select jsonb_agg(b) from public.bank_mutations b),'payment',(select jsonb_agg(p) from public.payments p)) data")).rows[0].data);
  assert.equal(noPayments, immutable);
  const arBeforeRollback = (await admin.query("select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') data from public.ar_subledger a")).rows[0].data;
  await admin.query(sqlFile("customer_ar_source_dev_ROLLBACK_REVIEW.sql"));
  assert.deepEqual((await admin.query("select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') data from public.ar_subledger a")).rows[0].data, arBeforeRollback);
  assert.equal((await admin.query("select count(*)::int n from pg_trigger where tgname like 'customer_ar_%_dev'")).rows[0].n, 0);
  assert.equal((await admin.query("select count(*)::int n from pg_policies where policyname like 'customer_ar_%'")).rows[0].n, 0);
  assert.equal((await admin.query("select has_any_column_privilege('bizportal_finance_cst_login_dev','public.ar_subledger','INSERT,UPDATE') allowed")).rows[0].allowed, false);
  await issue(admin, 80); await absent(80, "rolled back automation");
  check("rollback removes only projection permissions/wiring and preserves AR, GL, bank and payment history");
  console.log(`CUSTOMER_AR_SOURCE_PG${postgresMajor}_PASS checks=${passed}`);
}
main().catch((error) => { console.error("CUSTOMER_AR_SOURCE_POSTGRES_FAILED", error.message, error.code ?? ""); process.exitCode = 1; })
  .finally(async () => { await Promise.allSettled(clients.map((client) => client.end())); });
