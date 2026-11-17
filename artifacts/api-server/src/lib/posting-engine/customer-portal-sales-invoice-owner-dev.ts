/**
 * DEV-only composition adapter: reuse the ORIGINAL CanonicalPostingEngine
 * from this same API process on the caller's EXISTING pg Client transaction.
 *
 * This is a source-only building block and is NOT mounted or enabled by any
 * API route. Customer Portal must provide its own trusted, authenticated
 * same-session transactionClient; never open another pool or post to PROD.
 *
 * For taxAmount>0 the existing engine v1 lacks proven atomic tax posting:
 * fail closed until the original owner adds and certifies that capability.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { getPostingEngine } from "./index.js";

interface SalesInvoice {
  id: number;
  company_id: number;
  invoice_status: string;
  invoice_number: string;
  invoice_date: string | Date;
  due_date: string | Date;
  total_amount: string | number;
  tax_amount: string | number;
  grand_total: string | number;
  amount_paid: string | number;
  customer_name?: string | null;
}
export interface CustomerPortalPostingInput {
  transactionClient: pg.PoolClient;
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  companyId: number;
  source: "sales_invoice";
  sourceId: number;
  invoice: SalesInvoice;
  actorId: string | number | null;
}

function cents(value: unknown): number {
  const amount=Number(value);
  if (!Number.isFinite(amount)) throw new Error("DEV_SALES_POSTING_AMOUNT_INVALID");
  return Math.round(amount * 100);
}

/**
 * Runs under a caller-owned transaction. Never creates a new transaction,
 * DB pool, journal implementation, notification, customer, or payment record.
 * The original posting owner performs the journal/lines/status writes.
 */
export async function postCustomerPortalSalesInvoiceWithExistingOwner(
  input: CustomerPortalPostingInput,
): Promise<{ posted: boolean; entryId?: number }> {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV !== "true" ||
      process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV !== "true") {
    throw new Error("DEV_SALES_POSTING_NOT_ENABLED");
  }
  const {transactionClient:client,invoice,companyId,sourceId}=input;
  if (!client || typeof client.query !== "function" ||
      input.source !== "sales_invoice" || ![1,3].includes(companyId) ||
      !Number.isSafeInteger(sourceId) || sourceId <= 0 ||
      Number(invoice?.id) !== sourceId ||
      Number(invoice?.company_id) !== companyId ||
      invoice?.invoice_status !== "invoiced" ||
      !invoice?.invoice_number?.startsWith("INV-") ||
      !invoice.invoice_date || !invoice.due_date) {
    throw new Error("DEV_SALES_POSTING_INVOICE_SCOPE_INVALID");
  }
  // The original Customer Portal INVOICE_COLUMNS does NOT expose
  // tax_amount. Never treat missing fields in the client-facing response as
  // zero tax. Load all financial values from the same FOR UPDATE DB row,
  // then reject PPN until the original engine proves atomic tax posting.
  const source=await client.query(
    `select id,company_id,invoice_status,invoice_number,invoice_date,
            due_date,total_amount,grand_total,tax_amount,amount_paid
       from public.sales_documents
      where id=$1 and company_id=$2
      for update`, [sourceId,companyId],
  );
  const row=source.rows[0];
  if (source.rows.length!==1 || row?.invoice_status !== "invoiced" ||
      row?.invoice_number!==invoice.invoice_number ||
      Number(row?.company_id)!==companyId) {
    throw new Error("DEV_SALES_POSTING_SOURCE_MISMATCH");
  }
  const gross=cents(row.grand_total);
  const net=cents(row.total_amount);
  const tax=cents(row.tax_amount);
  const paid=cents(row.amount_paid);
  if (gross <= 0 || paid < 0 || paid > gross ||
      net < 0 || tax < 0 || gross !== net+tax ||
      cents(invoice.grand_total)!==gross ||
      cents(invoice.total_amount)!==net ||
      cents(invoice.amount_paid)!==paid ||
      (invoice.tax_amount != null && cents(invoice.tax_amount)!==tax)) {
    throw new Error("DEV_SALES_POSTING_FINANCIAL_TOTAL_INVALID");
  }
  if (tax !== 0) {
    // Existing posting engine v1 explicitly refuses request.taxes; do not
    // post a ledger without its legally correct and atomic PPN entry.
    throw new Error("DEV_SALES_POSTING_TAX_NOT_READY");
  }
  const settings=await client.query(
    `select s.sales_journal_id as journal,s.ar_account_id as ar,
            s.sales_income_account_id as revenue
       from public.accounting_settings s
       join public.accounting_journals j on j.id=s.sales_journal_id
          and j.company_id=s.company_id and j.is_active and j.type='sales'
       join public.chart_of_accounts a on a.id=s.ar_account_id
          and a.company_id=s.company_id and a.is_active and a.is_postable
          and a.status='ACTIVE'
       join public.chart_of_accounts r on r.id=s.sales_income_account_id
          and r.company_id=s.company_id and r.is_active and r.is_postable
          and r.status='ACTIVE'
      where s.company_id=$1`, [companyId],
  );
  if (settings.rows.length!==1) throw new Error("DEV_SALES_POSTING_SETTINGS_MISSING");
  const a=settings.rows[0];
  const money=gross/100;
  const result=await getPostingEngine().post({
    journalId:Number(a.journal),journalCode:"SAL",
    date:new Date(invoice.invoice_date),ref:invoice.invoice_number,
    description:"Invoice "+invoice.invoice_number,
    source:"sales_invoice",sourceId,companyId,
    createdById:input.actorId == null ? null : String(input.actorId),
    lines:[
      {accountId:Number(a.ar),debit:money,credit:0},
      {accountId:Number(a.revenue),debit:0,credit:money},
    ],
  },drizzle(client));
  if (!result.ok || !Number.isSafeInteger(result.entryId) || !result.entryId) {
    throw new Error("DEV_SALES_POSTING_OWNER_REJECTED");
  }
  return {posted:true,entryId:result.entryId};
}
