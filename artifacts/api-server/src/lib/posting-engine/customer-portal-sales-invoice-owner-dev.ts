/**
 * DEV-only composition adapter: reuse the ORIGINAL CanonicalPostingEngine
 * from this same API process on the caller's EXISTING pg Client transaction.
 *
 * This is a source-only building block and is NOT mounted or enabled by any
 * API route. Customer Portal must provide its own trusted, authenticated
 * same-session transactionClient; never open another pool or post to PROD.
 *
 * Positive-tax invoices remain OFF unless a separately approved DEV-only
 * PPN flag is enabled and the ORIGINAL invoice/default tax mapping is valid.
 * This adapter records gl_tax_lines REPORTING metadata through the exact
 * same caller-owned PostgreSQL client, after the byte-identical original
 * CanonicalPostingEngine posts the balanced 3-line GL. Any failure rolls
 * back the entire caller transaction; no second GL writer or pool is created.
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
            due_date,total_amount,grand_total,tax_amount,amount_paid,
            tax_rate_id,tax_treatment
       from public.sales_documents
      where id=$1 and company_id=$2
      for update`, [sourceId,companyId],
  );
  const row=source.rows[0];
  if (source.rows.length!==1 || Number(row?.id)!==sourceId ||
      !row?.invoice_date || !row?.due_date ||
      row?.invoice_status !== "invoiced" ||
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
  if (tax !== 0 && process.env.CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV !== "true") {
    // Existing universal tax rejection remains the default. Never silently
    // select a tax rate from this company's active alternative rates.
    throw new Error("DEV_SALES_POSTING_TAX_NOT_READY");
  }
  const settings=await client.query(
    `select s.sales_journal_id as journal,s.ar_account_id as ar,
            s.sales_income_account_id as revenue,
            s.default_sales_tax_id as default_tax_id,
            s.ppn_output_account_id as ppn_output_account,
            t.company_id as rate_company,t.id as rate_id,t.rate as rate_percent,
            t.account_id as rate_account,t.kind::text as rate_kind,
            t.cut_type::text as rate_cut_type,t.is_active as rate_active,
            p.company_id as ppn_company,p.type::text as ppn_type,
            p.status as ppn_status,p.is_active as ppn_active,
            p.is_postable as ppn_postable
       from public.accounting_settings s
       join public.accounting_journals j on j.id=s.sales_journal_id
          and j.company_id=s.company_id and j.is_active and j.type='sales'
       join public.chart_of_accounts a on a.id=s.ar_account_id
          and a.company_id=s.company_id and a.is_active and a.is_postable
          and a.status='ACTIVE'
       join public.chart_of_accounts r on r.id=s.sales_income_account_id
          and r.company_id=s.company_id and r.is_active and r.is_postable
          and r.status='ACTIVE'
       left join public.accounting_taxes t on t.id=s.default_sales_tax_id
       left join public.chart_of_accounts p on p.id=s.ppn_output_account_id
      where s.company_id=$1`, [companyId],
  );
  if (settings.rows.length!==1) throw new Error("DEV_SALES_POSTING_SETTINGS_MISSING");
  const a=settings.rows[0];
  let scopedPpn: { accountId: number; rate: number } | null = null;
  if (tax > 0) {
    const rateId = Number(row.tax_rate_id);
    const rate = Number(a.rate_percent);
    const ppnAccount = Number(a.ppn_output_account);
    if (!Number.isSafeInteger(rateId) || rateId <= 0 ||
        rateId !== Number(a.default_tax_id) ||
        rateId !== Number(a.rate_id) ||
        Number(a.rate_company) !== companyId ||
        a.rate_kind !== "sale" || a.rate_cut_type !== "self_borne" ||
        a.rate_active !== true || row.tax_treatment !== "exclusive" ||
        Number(a.ppn_company) !== companyId ||
        a.ppn_type !== "liability" || a.ppn_status !== "ACTIVE" ||
        a.ppn_active !== true || a.ppn_postable !== true ||
        !Number.isSafeInteger(ppnAccount) || ppnAccount <= 0 ||
        Number(a.rate_account) !== ppnAccount ||
        (rate !== 11 && rate !== 12) ||
        Math.round(net * rate / 100) !== tax) {
      throw new Error("DEV_SALES_POSTING_TAX_SETTINGS_NOT_READY");
    }
    scopedPpn = {accountId:ppnAccount,rate};
  }
  const money=gross/100;
  const result=await getPostingEngine().post({
    journalId:Number(a.journal),journalCode:"SAL",
    date:new Date(row.invoice_date),ref:row.invoice_number,
    description:"Invoice "+invoice.invoice_number,
    source:"sales_invoice",sourceId,companyId,
    createdById:input.actorId == null ? null : String(input.actorId),
    lines:[
      {accountId:Number(a.ar),debit:money,credit:0},
      {accountId:Number(a.revenue),debit:0,credit:scopedPpn ? net/100 : money},
      ...(scopedPpn ? [{
        accountId:scopedPpn.accountId,debit:0,credit:tax/100,
      }] : []),
    ],
    // Intentionally do NOT pass request.taxes: the original universal v1 tax
    // rejection and all its byte-identical protected logic remain intact.
    // The three GL lines are posted by its original canonical writer. The
    // local DEV adapter owns only the pre-COMMIT tax reporting metadata.
  },drizzle(client));
  if (!result.ok || !Number.isSafeInteger(result.entryId) || !result.entryId) {
    throw new Error("DEV_SALES_POSTING_OWNER_REJECTED");
  }
  if (scopedPpn) {
    // This is reporting metadata, NOT a second journal writer. Caller has
    // already FOR UPDATE-locked the exact Invoice on the same PG client.
    // A failure here MUST throw so Portal's outer transaction rolls back the
    // original 3-line GL, Invoice status, AR, outbox and audit together.
    const existing = await client.query(
      `select id from public.gl_tax_lines
        where company_id=$1 and accounting_entry_id=$2
          and tax_type='PPN_OUT' and direction='out'
        limit 2 for update`,
      [companyId,result.entryId],
    );
    if (existing.rows.length !== 0) {
      throw new Error("DEV_SALES_POSTING_TAX_METADATA_DUPLICATE");
    }
    const period = new Date(row.invoice_date).toISOString().slice(0,7);
    const inserted = await client.query(
      `insert into public.gl_tax_lines
         (company_id,accounting_entry_id,tax_type,rate,base_amount,
          tax_amount,direction,period,entity_type,entity_id)
       values($1,$2,'PPN_OUT',$3,$4,$5,'out',$6,'sales_invoice',$7)
       returning id`,
      [
        companyId,result.entryId,scopedPpn.rate,net/100,tax/100,
        period,String(sourceId),
      ],
    );
    const taxLineId = Number(inserted.rows[0]?.id);
    if (inserted.rows.length !== 1 ||
        !Number.isSafeInteger(taxLineId) || taxLineId <= 0) {
      throw new Error("DEV_SALES_POSTING_TAX_METADATA_NOT_PERSISTED");
    }
    const proof = await client.query(
      `select id,company_id,accounting_entry_id,tax_type,rate,
              base_amount,tax_amount,direction,entity_type,entity_id
         from public.gl_tax_lines
        where id=$1 and company_id=$2 and accounting_entry_id=$3
        limit 2`,
      [taxLineId,companyId,result.entryId],
    );
    const t = proof.rows[0];
    if (proof.rows.length !== 1 ||
        Number(t?.id) !== taxLineId ||
        Number(t?.company_id) !== companyId ||
        Number(t?.accounting_entry_id) !== result.entryId ||
        t?.tax_type !== "PPN_OUT" || t?.direction !== "out" ||
        t?.entity_type !== "sales_invoice" ||
        t?.entity_id !== String(sourceId) ||
        Number(t?.rate) !== scopedPpn.rate ||
        cents(t?.base_amount) !== net ||
        cents(t?.tax_amount) !== tax) {
      throw new Error("DEV_SALES_POSTING_TAX_METADATA_MISMATCH");
    }
  }
  return {posted:true,entryId:result.entryId};
}
