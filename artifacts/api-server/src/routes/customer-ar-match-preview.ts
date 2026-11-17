import { Router, type IRouter } from "express";
import { pool, withMarketplaceFinanceDevReadOnlyTransaction } from "@workspace/db";
import { sql } from "drizzle-orm";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";
import {
  getProductionSession, isDevelopmentEnvironment, isSignedDevAuthEnabled,
  getFinanceCompanyScope, isApprovedFinanceGlobalSuperAdmin, isApprovedFinanceGlobalCompany,
} from "./dev-auth";
import { buildCustomerArMatchPreview, type CustomerArInvoiceEvidence, type IncomingBankMutationEvidence } from "../lib/reconciliation/customerArMatchPreview";
import { CUSTOMER_AR_INVOICES_SQL } from "../lib/reconciliation/customerArSourceSql";

const router: IRouter = Router();
router.use(authenticateAdmin);

const MUTATIONS_SQL = [
  "select id, company_id, direction, status, amount,",
  "description, bank_reference, provider_order_id",
  "from public.bank_mutations",
  "where company_id = $1 and upper(direction) = 'IN' and lower(status) = 'unmatched'",
  "order by created_at desc, id desc limit 300",
].join("\n");

type InvoiceRow = {
  id: number; company_id: number; invoice_number: string | null;
  customer_name: string | null; invoice_status: string;
  document_status: string; payment_status: string;
  outstanding_amount: string | null; ar_journal_posted: boolean | null;
};
type MutationRow = {
  id: number; company_id: number; direction: string; status: string;
  amount: string; description: string | null; bank_reference: string | null;
  provider_order_id: string | null;
};

// Keep the shared SQL parameterized when executed through a scoped Drizzle
// connection. Both statements contain exactly one company placeholder.
function scopedStatement(statement: string, companyId: number) {
  const parts = statement.split("$1");
  if (parts.length !== 2) throw new Error("CUSTOMER_AR_COMPANY_PARAMETER_INVALID");
  return sql`${sql.raw(parts[0]!)}${companyId}${sql.raw(parts[1]!)}`;
}

/** Read-only preview. Never approves a mutation or posts a payment/journal. */
router.get("/sales/customer-invoices/auto-match-preview", async (request, response): Promise<void> => {
  if (!isDevelopmentEnvironment()) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const actor = (request as AdminRequest).adminUser;
  const requestedId = request.query.company_id ?? actor?.companyId;
  const companyId = Number(requestedId);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    response.status(400).json({ error: "Pilih perusahaan untuk pemeriksaan AR.", code: "COMPANY_REQUIRED" });
    return;
  }
  const isPrivileged = ["super_admin", "owner"].includes(actor?.role.toLowerCase() ?? "");
  if (actor?.companyId != null && actor.companyId !== companyId && !isPrivileged) {
    response.status(403).json({ error: "Perusahaan di luar hak akses.", code: "COMPANY_SCOPE_MISMATCH" });
    return;
  }
  if (actor?.companyId == null && !isPrivileged) {
    response.status(403).json({ error: "Hak akses perusahaan tidak terverifikasi.", code: "COMPANY_SCOPE_MISSING" });
    return;
  }
  // OTP opt-in retains legacy DEV cookie compatibility for scoped requests.
  // The legacy cookie alone is not sufficient for a global/cross-company
  // Customer AR read. authenticateAdmin has already DB-verified any signed OTP
  // identity before this handler is reached.
  const crossesCompany = actor?.companyId == null || actor.companyId !== companyId;
  if (isPrivileged && crossesCompany && isSignedDevAuthEnabled() &&
      !getProductionSession(request)) {
    response.status(403).json({
      error: "Akses lintas perusahaan membutuhkan sesi Admin terverifikasi.",
      code: "SIGNED_GLOBAL_ADMIN_REQUIRED",
    });
    return;
  }

  const companyMode = process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV === "true";
  if (companyMode) {
    const session = getProductionSession(request);
    if (!session) {
      response.status(403).json({ error: "Sesi Finance terverifikasi diperlukan.", code: "CUSTOMER_AR_SIGNED_SESSION_REQUIRED" });
      return;
    }
    if (![1, 3].includes(companyId)) {
      response.status(403).json({ error: "Perusahaan belum diaktifkan untuk Customer AR.", code: "CUSTOMER_AR_COMPANY_NOT_ENABLED" });
      return;
    }
    // A query/header never widens a company-bound account. Global Super Admin
    // uses the existing approved, signed, session-bound Finance selection.
    const ownsCompany = actor?.companyId === companyId;
    const approvedGlobal = actor?.companyId == null
      && actor?.role.toLowerCase() === "super_admin"
      && isApprovedFinanceGlobalSuperAdmin(actor.email)
      && isApprovedFinanceGlobalCompany(companyId)
      && getFinanceCompanyScope(request, session) === companyId;
    if (!ownsCompany && !approvedGlobal) {
      response.status(403).json({ error: "Cakupan perusahaan Finance tidak sesuai.", code: "CUSTOMER_AR_SIGNED_COMPANY_SCOPE_REQUIRED" });
      return;
    }
  }

  try {
    if (companyMode) {
      // This is authentication metadata in the existing OTP pool, not a
      // fallback for financial reads. Recheck a selected company's active state.
      const active = await pool.query<{ id: number }>(
        "select id from public.companies where id=$1 and coalesce(is_active,true)=true limit 1", [companyId],
      );
      if (active.rows.length !== 1) {
        response.status(404).json({ error: "Perusahaan tidak tersedia.", code: "CUSTOMER_AR_COMPANY_UNAVAILABLE" });
        return;
      }
    }
    const [invoiceRows, mutationRows] = companyMode
      ? await withMarketplaceFinanceDevReadOnlyTransaction(companyId, async (scopedDb) => {
        const invoices = await scopedDb.execute<InvoiceRow>(scopedStatement(CUSTOMER_AR_INVOICES_SQL, companyId));
        const mutations = await scopedDb.execute<MutationRow>(scopedStatement(MUTATIONS_SQL, companyId));
        return [invoices, mutations] as const;
      })
      : await Promise.all([
        pool.query<InvoiceRow>(CUSTOMER_AR_INVOICES_SQL, [companyId]),
        pool.query<MutationRow>(MUTATIONS_SQL, [companyId]),
      ]);

    const invoices: CustomerArInvoiceEvidence[] = invoiceRows.rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      invoiceNumber: row.invoice_number,
      customerName: row.customer_name,
      invoiceStatus: row.invoice_status,
      documentStatus: row.document_status,
      paymentStatus: row.payment_status,
      outstandingAmount: row.outstanding_amount == null ? null : Number(row.outstanding_amount),
      arJournalPosted: row.ar_journal_posted === true,
    }));
    const mutations: IncomingBankMutationEvidence[] = mutationRows.rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      direction: row.direction,
      status: row.status,
      amount: Number(row.amount),
      description: row.description,
      bankReference: row.bank_reference,
      providerOrderId: row.provider_order_id,
    }));
    const matches = buildCustomerArMatchPreview(invoices, mutations);
    const summary = {
      invoicedDocuments: invoices.length,
      missingInvoiceNumbers: invoices.filter((invoice) => !invoice.invoiceNumber?.trim()).length,
      missingPostedArEvidence: invoices.filter((invoice) => !invoice.arJournalPosted || invoice.outstandingAmount == null).length,
      unmatchedIncomingMutations: mutations.length,
      suggestedExact: matches.filter((match) => match.status === "candidate_ready_for_review").length,
      requiresReview: matches.filter((match) => match.status !== "candidate_ready_for_review").length,
    };
    response.json({
      mode: "read_only_preview",
      autoApproveEnabled: false,
      autoPostEnabled: false,
      companyId, summary, matches,
      warning: "Kandidat ini belum menjadi pembayaran/rekonsiliasi. Approval dan jurnal hanya melalui lifecycle canonical.",
    });
  } catch (error) {
    request.log.error({ error, companyId }, "Customer AR matching preview failed");
    response.status(503).json({ error: "Pemeriksaan matching Customer AR belum tersedia.", code: "CUSTOMER_AR_PREVIEW_UNAVAILABLE" });
  }
});

export default router;
