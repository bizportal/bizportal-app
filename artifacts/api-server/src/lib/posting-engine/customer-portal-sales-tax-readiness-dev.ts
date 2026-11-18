/**
 * DEV-only PPN readiness preflight for Customer Portal Invoice.
 *
 * Reads only the original existing sales_documents / accounting_settings /
 * accounting_taxes / chart_of_accounts on a caller-supplied PG transaction
 * query. It never guesses 11% vs 12%, modifies a company default, starts a
 * transaction, writes an accounting line or bypasses CanonicalPostingEngine v1
 * (which still fails closed on tax). This is NOT an activation gate.
 */
export type CustomerInvoiceTaxReadinessCode =
  | "NOT_DEV"
  | "INVALID_SOURCE"
  | "ZERO_TAX"
  | "INVALID_FINANCIAL_AMOUNTS"
  | "DEFAULT_SALES_TAX_MISSING"
  | "DEFAULT_SALES_TAX_COMPANY_MISMATCH"
  | "DEFAULT_SALES_TAX_INACTIVE"
  | "OUTPUT_TAX_ACCOUNT_INVALID"
  | "INVOICE_TAX_RATE_REQUIRED"
  | "INVOICE_TAX_RATE_COMPANY_MISMATCH"
  | "INVOICE_TAX_RATE_INACTIVE"
  | "INVOICE_TAX_RATE_ACCOUNT_MISMATCH"
  | "INVOICE_TAX_RATE_NOT_DEFAULT"
  | "INVOICE_TAX_TREATMENT_REVIEW"
  | "CANONICAL_TAX_POSTING_NOT_READY";

export type CustomerInvoiceTaxReadiness = {
  eligible: false;
  code: CustomerInvoiceTaxReadinessCode;
  companyId: number;
  invoiceId: number;
};

export type SameTransactionRead = (
  sql: string, params: Array<string | number>,
) => Promise<{ rows: Record<string, unknown>[] }>;

const cents = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const v = Number(x);
  if (!Number.isFinite(v) || Math.abs(v) > 1_000_000_000_000) return null;
  return Math.round(v * 100);
};
const result = (
  companyId: number, invoiceId: number, code: CustomerInvoiceTaxReadinessCode,
): CustomerInvoiceTaxReadiness => ({eligible:false,code,companyId,invoiceId});

/**
 * This module may be called ONLY from an existing caller-owned DEV read path.
 * All operations are SELECTs with parameters; no tax ID fallback is permitted.
 */
export async function inspectCustomerInvoiceTaxReadinessDev({
  read, companyId, invoiceId,
}: {
  read: SameTransactionRead;
  companyId: number;
  invoiceId: number;
}): Promise<CustomerInvoiceTaxReadiness> {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development")
    return result(companyId,invoiceId,"NOT_DEV");
  if (![1,3].includes(companyId) || !Number.isSafeInteger(invoiceId) ||
      invoiceId < 1 || typeof read !== "function")
    return result(companyId,invoiceId,"INVALID_SOURCE");

  const source = await read(
    `select id,company_id,total_amount,tax_amount,grand_total,
            tax_rate_id,tax_treatment
       from public.sales_documents
      where id=$1 and company_id=$2`,
    [invoiceId,companyId],
  );
  if (source.rows.length !== 1) return result(companyId,invoiceId,"INVALID_SOURCE");
  const doc = source.rows[0];
  if (Number(doc.id) !== invoiceId || Number(doc.company_id) !== companyId)
    return result(companyId,invoiceId,"INVALID_SOURCE");
  const net = cents(doc.total_amount), tax = cents(doc.tax_amount),
    gross = cents(doc.grand_total);
  if (net === null || tax === null || gross === null ||
      net < 0 || tax < 0 || gross <= 0 || net + tax !== gross)
    return result(companyId,invoiceId,"INVALID_FINANCIAL_AMOUNTS");
  if (tax === 0) return result(companyId,invoiceId,"ZERO_TAX");

  // Intentionally do NOT join the default tax on company ID here: a stale
  // settings pointer to the OTHER company must be detected, not hidden.
  const settings = await read(
    `select s.default_sales_tax_id,s.ppn_output_account_id,
            t.company_id as default_tax_company,
            t.kind::text as default_tax_kind,
            t.cut_type::text as default_tax_cut_type,
            t.is_active as default_tax_active,
            a.company_id as output_account_company,
            a.type::text as output_account_type,
            a.status as output_account_status,
            a.is_active as output_account_active,
            a.is_postable as output_account_postable
       from public.accounting_settings s
       left join public.accounting_taxes t on t.id=s.default_sales_tax_id
       left join public.chart_of_accounts a on a.id=s.ppn_output_account_id
      where s.company_id=$1`,
    [companyId],
  );
  if (settings.rows.length !== 1)
    return result(companyId,invoiceId,"DEFAULT_SALES_TAX_MISSING");
  const setup = settings.rows[0];
  if (!Number.isSafeInteger(Number(setup.default_sales_tax_id)) ||
      Number(setup.default_sales_tax_id) < 1 ||
      setup.default_tax_company == null)
    return result(companyId,invoiceId,"DEFAULT_SALES_TAX_MISSING");
  if (Number(setup.default_tax_company) !== companyId)
    return result(companyId,invoiceId,"DEFAULT_SALES_TAX_COMPANY_MISMATCH");
  if (setup.default_tax_active !== true ||
      setup.default_tax_kind !== "sale" ||
      setup.default_tax_cut_type !== "self_borne")
    return result(companyId,invoiceId,"DEFAULT_SALES_TAX_INACTIVE");
  if (Number(setup.output_account_company) !== companyId ||
      setup.output_account_type !== "liability" ||
      setup.output_account_status !== "ACTIVE" ||
      setup.output_account_active !== true ||
      setup.output_account_postable !== true)
    return result(companyId,invoiceId,"OUTPUT_TAX_ACCOUNT_INVALID");

  if (!Number.isSafeInteger(Number(doc.tax_rate_id)) || Number(doc.tax_rate_id) < 1)
    return result(companyId,invoiceId,"INVOICE_TAX_RATE_REQUIRED");
  const applied = await read(
    `select id,company_id,kind::text as kind,cut_type::text as cut_type,
            rate,is_active,account_id
       from public.accounting_taxes
      where id=$1`,
    [Number(doc.tax_rate_id)],
  );
  if (applied.rows.length !== 1)
    return result(companyId,invoiceId,"INVOICE_TAX_RATE_REQUIRED");
  const rate = applied.rows[0];
  if (Number(rate.company_id) !== companyId)
    return result(companyId,invoiceId,"INVOICE_TAX_RATE_COMPANY_MISMATCH");
  if (rate.kind !== "sale" || rate.cut_type !== "self_borne" ||
      rate.is_active !== true || cents(rate.rate) === null)
    return result(companyId,invoiceId,"INVOICE_TAX_RATE_INACTIVE");
  if (Number(rate.account_id) !== Number(setup.ppn_output_account_id))
    return result(companyId,invoiceId,"INVOICE_TAX_RATE_ACCOUNT_MISMATCH");
  if (Number(doc.tax_rate_id) !== Number(setup.default_sales_tax_id))
    return result(companyId,invoiceId,"INVOICE_TAX_RATE_NOT_DEFAULT");
  if (!["exclusive","inclusive"].includes(String(doc.tax_treatment??"")))
    return result(companyId,invoiceId,"INVOICE_TAX_TREATMENT_REVIEW");

  // Even a tenant-consistent mapping does NOT establish legally correct DPP,
  // rounding or atomic gl_tax_lines. Original engine v1 still rejects taxes.
  return result(companyId,invoiceId,"CANONICAL_TAX_POSTING_NOT_READY");
}
