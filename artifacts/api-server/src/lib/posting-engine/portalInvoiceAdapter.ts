/**
 * DEV-only bridge for Customer Portal PR206, using the ORIGINAL canonical
 * Accounting owner. This module is deliberately NOT mounted by the API.
 *
 * The Portal must call this in-process after its sales_documents UPDATE and
 * before COMMIT, with the very same checked-out pg PoolClient and query closure.
 * An HTTP hop or a new pool would break atomicity and is not supported.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { getPostingEngine } from "./index.js";
import type { DbClient } from "../accounting.js";

type QueryRows = { rows: Array<Record<string, unknown>> };
type QueryFunction = (sql: string, values?: unknown[]) => Promise<QueryRows>;

export interface PortalInvoicePostingInput {
  query: QueryFunction;
  transactionClient: PoolClient;
  companyId: number;
  source: "sales_invoice";
  sourceId: number;
  invoice: {
    id: number | string;
    company_id: number | string;
    invoice_number?: string | null;
    grand_total?: number | string | null;
  };
  actorId: number | string | null;
}
export interface PortalInvoicePostingReceipt {
  posted: true;
  entryId: number;
}

function refuse(code: string): never {
  throw new Error("CUSTOMER_INVOICE_POSTING_" + code);
}
function positiveId(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
function money(value: unknown): number {
  if (value == null || typeof value === "boolean") refuse("INVALID_MONEY");
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 100))) {
    refuse("INVALID_MONEY");
  }
  if (Math.abs(n * 100 - Math.round(n * 100)) > 0.000001) refuse("MONEY_PRECISION");
  return Math.round(n * 100) / 100;
}
function dateOnly(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) refuse("INVALID_DATE");
  const date = new Date(value + "T12:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) refuse("INVALID_DATE");
  return value;
}
function fieldId(row: Record<string, unknown>, name: string): number {
  const id = positiveId(row[name]);
  if (!id) refuse("ACCOUNTING_CONFIGURATION_MISSING");
  return id;
}
function sameAmount(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.005;
}
function properCompanyAccount(
  row: Record<string, unknown>, prefix: "ar" | "revenue", companyId: number, type: "asset" | "revenue",
): boolean {
  return Number(row[prefix + "_company"]) === companyId
    && row[prefix + "_type"] === type
    && row[prefix + "_active"] === true
    && row[prefix + "_postable"] === true
    && row[prefix + "_header"] === false
    && row[prefix + "_status"] === "ACTIVE";
}

/**
 * The underlying postEntryWithClient stays intact: period locks, source
 * idempotency, COA governance and balance are checked by the original engine.
 * This bridge only provides trusted company mappings and a bound transaction.
 */
export async function postCustomerInvoiceWithOriginalOwner(
  input: PortalInvoicePostingInput,
): Promise<PortalInvoicePostingReceipt> {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development"
      || process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV !== "true"
      || process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV !== "true") {
    refuse("DEV_FLAGS_OFF");
  }
  const { query, transactionClient } = input;
  if (typeof query !== "function" || typeof transactionClient?.query !== "function") {
    refuse("TRANSACTION_CLIENT_MISSING");
  }
  const companyId = positiveId(input.companyId);
  const sourceId = positiveId(input.sourceId);
  if (![1, 3].includes(companyId) || !sourceId || input.source !== "sales_invoice"
      || Number(input.invoice?.id) !== sourceId
      || Number(input.invoice?.company_id) !== companyId
      || !String(input.actorId ?? "").trim()) {
    refuse("COMPANY_OR_SOURCE_MISMATCH");
  }

  // The Portal has already UPDATED the invoice in an explicit BEGIN. Both
  // query interfaces must report one backend and one ASSIGNED transaction ID.
  // In autocommit, this check does not silently allow a separate pool.
  const traceSql = [
    "select pg_backend_pid()::int as backend_pid,",
    "pg_current_xact_id_if_assigned()::text as xid,",
    "current_setting('transaction_read_only') as read_only",
  ].join("\n");
  const [a] = (await query(traceSql)).rows;
  const [b] = (await transactionClient.query(traceSql)).rows as Array<Record<string, unknown>>;
  if (!a || !b || !a.xid || a.xid !== b.xid || a.backend_pid !== b.backend_pid
      || a.read_only !== "off" || b.read_only !== "off") {
    refuse("NOT_SAME_WRITABLE_TRANSACTION");
  }

  // Never trust the HTTP-supplied invoice amount, company or source identity.
  const invoiceSql = [
    "select id,company_id,status::text as status,invoice_status::text as invoice_status,",
    "invoice_number,invoice_date::text as invoice_date,due_date::text as due_date,",
    "grand_total,total_amount,amount_paid,payment_status::text as payment_status,",
    "tax_amount,tax_rate_id,tax_treatment",
    "from public.sales_documents",
    "where id=$1 and company_id=$2 for update",
  ].join("\n");
  const invoiceRows = (await query(invoiceSql, [sourceId, companyId])).rows;
  if (invoiceRows.length !== 1) refuse("SOURCE_NOT_FOUND");
  const invoice = invoiceRows[0]!;
  const invoiceNumber = String(invoice.invoice_number ?? "").trim();
  const gross = money(invoice.grand_total);
  const preTaxTotal = money(invoice.total_amount);
  const paid = money(invoice.amount_paid);
  const invoiceDate = dateOnly(invoice.invoice_date);
  const dueDate = dateOnly(invoice.due_date);
  if (invoice.invoice_status !== "invoiced"
      || !["confirmed", "done", "completed"].includes(String(invoice.status))
      || !invoiceNumber || dueDate < invoiceDate
      || Number(invoice.company_id) !== companyId
      || Number(invoice.id) !== sourceId
      || invoiceNumber !== String(input.invoice?.invoice_number ?? "").trim()
      || !sameAmount(gross, money(input.invoice?.grand_total))
      || gross <= 0 || paid > gross
      || (paid === 0 && invoice.payment_status !== "unpaid")
      || (paid > 0 && paid < gross && invoice.payment_status !== "partial")
      || (paid === gross && invoice.payment_status !== "paid")) {
    refuse("INVALID_INVOICE_SOURCE");
  }

  // Only a transparently represented, exclusive output PPN can be recorded.
  // Tax rate/account mapping is independently verified below using this same
  // transaction. Special DPP, inclusive taxes and unexplained adjustments stay
  // fail-closed; no historical invoice is repaired or recalculated.
  const taxAmount = money(invoice.tax_amount);
  const taxId = invoice.tax_rate_id == null ? 0 : positiveId(invoice.tax_rate_id);
  const taxable = taxAmount > 0;
  const treatment = String(invoice.tax_treatment ?? "").trim().toLowerCase();
  if (taxable) {
    if (!taxId || treatment !== "exclusive"
        || !sameAmount(gross, preTaxTotal + taxAmount)) {
      refuse("TAX_OR_ADJUSTMENT_UNSUPPORTED");
    }
  } else if (taxId || !["", "none", "non_taxable", "non-taxable", "non_pkp", "non-pkp", "exempt"].includes(treatment)
      || !sameAmount(gross, preTaxTotal)) {
    refuse("TAX_OR_ADJUSTMENT_UNSUPPORTED");
  }
  const sourceLines = await query(
    "select count(*)::int as line_count,coalesce(sum(subtotal),0) as line_total from public.sales_document_lines where document_id=$1",
    [sourceId],
  );
  if (Number(sourceLines.rows[0]?.line_count) < 1
      || !sameAmount(money(sourceLines.rows[0]?.line_total), preTaxTotal)) {
    refuse("LINE_TOTAL_MISMATCH");
  }

  const settingsSql = [
    "select s.ar_account_id,s.sales_income_account_id,s.sales_journal_id,",
    "j.code as journal_code,j.company_id as journal_company,j.type::text as journal_type,j.is_active as journal_active,",
    "ar.company_id as ar_company,ar.type::text as ar_type,ar.subtype as ar_subtype,",
    "ar.is_active as ar_active,ar.is_postable as ar_postable,ar.is_header as ar_header,ar.status as ar_status,",
    "rev.company_id as revenue_company,rev.type::text as revenue_type,",
    "rev.is_active as revenue_active,rev.is_postable as revenue_postable,rev.is_header as revenue_header,rev.status as revenue_status",
    "from public.accounting_settings s",
    "left join public.accounting_journals j on j.id=s.sales_journal_id",
    "left join public.chart_of_accounts ar on ar.id=s.ar_account_id",
    "left join public.chart_of_accounts rev on rev.id=s.sales_income_account_id",
    "where s.company_id=$1 limit 2",
  ].join("\n");
  const settingsRows = (await query(settingsSql, [companyId])).rows;
  if (settingsRows.length !== 1) refuse("ACCOUNTING_CONFIGURATION_MISSING");
  const cfg = settingsRows[0]!;
  const arId = fieldId(cfg, "ar_account_id");
  const revenueId = fieldId(cfg, "sales_income_account_id");
  const journalId = fieldId(cfg, "sales_journal_id");
  if (arId === revenueId || cfg.journal_company !== companyId
      || cfg.journal_type !== "sales" || cfg.journal_active !== true
      || typeof cfg.journal_code !== "string" || !cfg.journal_code.trim()
      || !properCompanyAccount(cfg, "ar", companyId, "asset")
      || cfg.ar_subtype !== "receivable"
      || !properCompanyAccount(cfg, "revenue", companyId, "revenue")) {
    refuse("INVALID_COMPANY_ACCOUNTING_MAPPING");
  }

  let outputTaxAccountId = 0;
  let taxName = "";
  let taxRate = 0;
  if (taxable) {
    const taxRows = (await query([
      "select t.id,t.company_id,t.name,t.rate,t.kind::text as kind,t.is_active,",
      "t.account_id, s.default_sales_tax_id,s.ppn_output_account_id,",
      "coa.company_id as coa_company,coa.type::text as coa_type,",
      "coa.is_active as coa_active,coa.is_postable as coa_postable,",
      "coa.is_header as coa_header,coa.status as coa_status",
      "from public.accounting_taxes t",
      "join public.accounting_settings s on s.company_id=t.company_id",
      "join public.chart_of_accounts coa on coa.id=s.ppn_output_account_id",
      "where t.id=$1 and t.company_id=$2 limit 2",
    ].join("\n"), [taxId, companyId])).rows;
    if (taxRows.length !== 1) refuse("TAX_CONFIGURATION_MISSING");
    const t = taxRows[0]!;
    outputTaxAccountId = positiveId(t.ppn_output_account_id);
    taxName = String(t.name ?? "").trim();
    taxRate = Number(t.rate);
    if (!outputTaxAccountId || !taxName || t.kind !== "sale" || t.is_active !== true
        || Number(t.company_id) !== companyId
        || Number(t.default_sales_tax_id) !== taxId
        || Number(t.account_id) !== outputTaxAccountId
        || Number(t.coa_company) !== companyId || t.coa_type !== "liability"
        || t.coa_active !== true || t.coa_postable !== true
        || t.coa_header !== false || t.coa_status !== "ACTIVE"
        || !Number.isFinite(taxRate) || taxRate <= 0 || taxRate > 100
        || !sameAmount(taxAmount, Math.round(preTaxTotal * taxRate) / 100)) {
      refuse("TAX_CONFIGURATION_OR_AMOUNT_MISMATCH");
    }
  }

  // drizzle(client) uses the EXACT checked-out pg PoolClient. It does not
  // use @workspace/db's global pool. Cast only bridges schema typing: the
  // underlying select/insert/update/execute methods are identical.
  const transactionDb = drizzle(transactionClient) as unknown as DbClient;
  const result = await getPostingEngine().post({
    journalId,
    journalCode: cfg.journal_code.trim(),
    date: new Date(invoiceDate + "T12:00:00.000Z"),
    ref: invoiceNumber,
    description: "Customer Invoice " + invoiceNumber,
    source: "sales_invoice",
    sourceId,
    companyId,
    createdById: String(input.actorId),
    initialStatus: "posted",
    lines: [
      { accountId: arId, debit: gross, credit: 0 },
      { accountId: revenueId, debit: 0, credit: preTaxTotal },
      ...(taxable ? [{ accountId: outputTaxAccountId, debit: 0, credit: taxAmount }] : []),
    ],
  }, transactionDb);
  const entryId = positiveId(result.entryId);
  if (result.ok !== true || !entryId) refuse("EXISTING_ENGINE_REJECTED");

  if (taxable) {
    // Reused posted source must have the exact AR/revenue/PPN split. Never
    // attach a tax row to a legacy posted two-line or mismatched journal.
    const posted = (await query([
      "select e.status::text as status,e.company_id,e.source_id,",
      "e.total_debit,e.total_credit, l.account_id,l.debit,l.credit",
      "from public.accounting_entries e",
      "join public.accounting_entry_lines l on l.entry_id=e.id",
      "where e.id=$1 and e.company_id=$2 and e.source='sales_invoice'",
      "and e.source_id=$3 and not e.is_voided and not e.is_reversed",
      "order by l.account_id",
    ].join("\n"), [entryId, companyId, sourceId])).rows;
    const signature = posted.map((r) =>
      [Number(r.account_id), money(r.debit), money(r.credit)].join(":")).sort();
    const expected = [
      [arId, gross, 0], [revenueId, 0, preTaxTotal],
      [outputTaxAccountId, 0, taxAmount],
    ].map((line) => line.join(":")).sort();
    if (posted.length !== 3 || posted.some((r) =>
      r.status !== "posted" || Number(r.company_id) !== companyId
      || Number(r.source_id) !== sourceId
      || !sameAmount(money(r.total_debit), gross)
      || !sameAmount(money(r.total_credit), gross))
      || JSON.stringify(signature) !== JSON.stringify(expected)) {
      refuse("TAX_JOURNAL_SPLIT_MISMATCH");
    }
    // Existing transaction_taxes ledger: inserted on the same checked-out
    // PostgreSQL client. If any later work fails, caller ROLLBACK removes
    // journal, tax row, AR projection, audit and outbox together.
    await query([
      "insert into public.transaction_taxes",
      "(company_id,transaction_type,transaction_id,transaction_ref,tax_id,",
      "tax_name,tax_rate,cut_type,base_amount,tax_amount,account_id,",
      "period,status,direction,posted_at)",
      "values ($1,'sales_invoice',$2,$3,$4,$5,$6,'self_borne',$7,$8,$9,$10,'posted','output',now())",
      "on conflict (transaction_type,transaction_id,tax_id) do nothing",
    ].join("\n"), [
      companyId,sourceId,invoiceNumber,taxId,taxName,taxRate,
      preTaxTotal,taxAmount,outputTaxAccountId,invoiceDate.slice(0,7),
    ]);
    const taxEvidence = (await query([
      "select company_id,tax_id,transaction_ref,tax_rate,base_amount,",
      "tax_amount,account_id,status,direction from public.transaction_taxes",
      "where transaction_type='sales_invoice' and transaction_id=$1",
    ].join("\n"), [sourceId])).rows;
    if (taxEvidence.length !== 1 || Number(taxEvidence[0]?.company_id) !== companyId
        || Number(taxEvidence[0]?.tax_id) !== taxId
        || taxEvidence[0]?.transaction_ref !== invoiceNumber
        || !sameAmount(Number(taxEvidence[0]?.tax_rate), taxRate)
        || !sameAmount(money(taxEvidence[0]?.base_amount),preTaxTotal)
        || !sameAmount(money(taxEvidence[0]?.tax_amount),taxAmount)
        || Number(taxEvidence[0]?.account_id) !== outputTaxAccountId
        || taxEvidence[0]?.status !== "posted"
        || taxEvidence[0]?.direction !== "output") {
      refuse("TAX_EVIDENCE_MISMATCH");
    }
  }

  // Journal audit and the EXISTING outbox are inserted on the same client.
  // The worker cannot observe either row until the Portal COMMIT succeeds.
  // No global pool, external message or legacy fire-and-forget effect is used.
  const event = {
    eventType: "JOURNAL_CREATED", entryId, sourceType: "sales_invoice",
    sourceId: String(sourceId), amount: gross, actor: String(input.actorId), companyId,
  };
  await query([
    "insert into public.ledger_events",
    "(company_id,event_type,period,entry_id,actor,payload)",
    "select $1,'POST',$2,$3,$4,$5::jsonb",
    "where not exists (select 1 from public.ledger_events",
    "where company_id=$1 and entry_id=$3 and event_type='POST')",
  ].join("\n"), [
    companyId, invoiceDate.slice(0, 7), entryId, String(input.actorId),
    JSON.stringify({ source: "sales_invoice", sourceId, invoiceNumber, amount: gross }),
  ]);
  await query([
    "insert into public.financial_outbox_events",
    "(event_type,payload,entry_id,company_id)",
    "select 'JOURNAL_CREATED',$1::jsonb,$2,$3",
    "where not exists (select 1 from public.financial_outbox_events",
    "where entry_id=$2 and company_id=$3 and event_type='JOURNAL_CREATED')",
  ].join("\n"), [JSON.stringify(event), entryId, companyId]);

  // Portal PR206 independently verifies the posted journal/source/lines and
  // SECURITY INVOKER AR view, before committing and notifying anyone.
  return { posted: true, entryId };
}
