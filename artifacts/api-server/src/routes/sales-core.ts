import { Router, type IRouter } from "express";
import { pool, type PayrollDbClient } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";
import { getProductionSession, getProductionUser, isDevelopmentEnvironment, isSignedOtpDevEnabled } from "./dev-auth";

const router: IRouter = Router();

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function numeric(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

router.use(authenticateAdmin);

router.get("/sales/ai-drafts", async (request, response): Promise<void> => {
  const adminRequest = request as AdminRequest;
  const companyId = adminRequest.adminUser?.companyId ?? null;

  try {
    const result = await pool.query<{
      id: number;
      doc_number: string;
      kind: string;
      status: string;
      invoice_status: string;
      delivery_status: string;
      payment_status: string;
      customer_id: number | null;
      customer_name: string;
      total_amount: string | number;
      tax_rate_id: number | null;
      tax_amount: string | number;
      grand_total: string | number;
      origin: string | null;
      destination: string | null;
      transport_mode: string | null;
      etd: string | Date | null;
      eta: string | Date | null;
      valid_until: string | Date | null;
      expected_date: string | Date | null;
      notes: string | null;
      confirmed_at: string | Date | null;
      amount_paid: string | number;
      created_at: string | Date;
      updated_at: string | Date;
      ai_generated: boolean;
      ai_source_wa_phone: string | null;
      ai_source_correspondence_id: number | null;
    }>(
      `select
         id, doc_number, kind::text kind, status::text status,
         invoice_status::text invoice_status, delivery_status::text delivery_status,
         payment_status::text payment_status, customer_id, customer_name,
         total_amount, tax_rate_id, tax_amount, grand_total,
         origin, destination, transport_mode, etd, eta, valid_until, expected_date,
         notes, confirmed_at, amount_paid, created_at, updated_at,
         ai_generated, ai_source_wa_phone, ai_source_correspondence_id
       from public.sales_documents
       where ai_generated = true
         and status::text = 'draft'
         and ($1::bigint is null or company_id = $1)
       order by created_at desc`,
      [companyId],
    );

    response.json(result.rows.map((row) => ({
      id: row.id,
      docNumber: row.doc_number,
      kind: row.kind,
      status: row.status,
      invoiceStatus: row.invoice_status,
      deliveryStatus: row.delivery_status,
      paymentStatus: row.payment_status,
      customerId: row.customer_id,
      customerName: row.customer_name,
      totalAmount: numeric(row.total_amount),
      taxRateId: row.tax_rate_id,
      taxAmount: numeric(row.tax_amount),
      grandTotal: numeric(row.grand_total),
      origin: row.origin,
      destination: row.destination,
      transportMode: row.transport_mode,
      etd: isoDate(row.etd),
      eta: isoDate(row.eta),
      validUntil: isoDate(row.valid_until),
      expectedDate: isoDate(row.expected_date),
      notes: row.notes,
      confirmedAt: isoDate(row.confirmed_at),
      customerAddress: null,
      amountPaid: numeric(row.amount_paid),
      createdAt: isoDate(row.created_at),
      updatedAt: isoDate(row.updated_at),
      aiGenerated: row.ai_generated,
      aiSourceWaPhone: row.ai_source_wa_phone,
      aiSourceCorrespondenceId: row.ai_source_correspondence_id,
    })));
  } catch (error) {
    request.log.error({ error }, "Failed to load AI draft quotations");
    response.status(503).json({ error: "Draft quotation data cannot be loaded." });
  }
});


/**
 * CST-DEV only — canonical Sales confirmation, intentionally NOT invoice issuance.
 * Does not import the legacy router, post a GL journal, or trust client action fields.
 * Default OFF. Signed BizPortal Super Admin OTP session required even if ordinary
 * DEV admin fallback authentication is enabled elsewhere.
 */
router.post("/sales/documents/:id/action", async (request, response): Promise<void> => {
  if (!isDevelopmentEnvironment() || process.env.APP_ENV !== "development" ||
      !isSignedOtpDevEnabled() ||
      process.env.BIZPORTAL_DEV_CANONICAL_SALES_CONFIRM_ENABLED !== "true") {
    response.status(404).json({ error: "Not found" });
    return;
  }
  if (request.body?.action !== "confirm") {
    response.status(403).json({ error: "Only Sales confirmation is supported" });
    return;
  }
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[1-9]\d*$/.test(request.params.id ?? "")) {
    response.status(400).json({ error: "Invalid Sales document ID" });
    return;
  }

  const session = getProductionSession(request);
  const actor = session ? await getProductionUser(session).catch(() => null) : null;
  // CST company 1 only. Neither unsigned DEV sessions nor a cross-company
  // Super Admin session can authorize this write.
  if (!session || !actor || actor.id !== session.id ||
      actor.email.trim().toLowerCase() !== session.email ||
      actor.role !== "super_admin" ||
      (actor.companyId !== null && Number(actor.companyId) !== 1)) {
    response.status(403).json({ error: "Signed CST Owner/Super Admin OTP session required" });
    return;
  }

  let client: PayrollDbClient | undefined;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    const found = await client.query<{
      id: number; company_id: number | null; customer_id: number | null;
      status: string; kind: string; invoice_status: string;
    }>(
      `SELECT id, company_id, customer_id, status::text, kind::text,
              invoice_status::text
         FROM public.sales_documents WHERE id=$1 FOR UPDATE`, [id],
    );
    const doc = found.rows[0];
    if (!doc || doc.company_id !== 1) {
      await client.query("ROLLBACK");
      inTransaction = false;
      response.status(404).json({ error: "Sales document not found" });
      return;
    }
    if (!Number.isSafeInteger(doc.customer_id) || (doc.customer_id ?? 0) <= 0) {
      await client.query("ROLLBACK");
      inTransaction = false;
      response.status(422).json({ error: "Sales Order must link an existing customer" });
      return;
    }
    const customer = await client.query(
      "SELECT id FROM public.customers WHERE id=$1 AND company_id=$2 FOR KEY SHARE",
      [doc.customer_id, doc.company_id],
    );
    if (customer.rowCount !== 1) {
      await client.query("ROLLBACK");
      inTransaction = false;
      response.status(422).json({ error: "Sales Order customer/company mismatch" });
      return;
    }
    if (!["draft", "sent"].includes(doc.status) || doc.invoice_status !== "none") {
      await client.query("ROLLBACK");
      inTransaction = false;
      response.status(409).json({ error: "Sales document is not confirmable" });
      return;
    }
    const updated = await client.query(
      `UPDATE public.sales_documents
          SET kind='order', status='confirmed', invoice_status='to_invoice',
              confirmed_at=NOW(), approved_by=$3, approved_at=NOW(),
              delivery_status='to_deliver', updated_at=NOW()
        WHERE id=$1 AND company_id=$2 AND status::text IN ('draft','sent')
          AND invoice_status::text='none'
        RETURNING id`,
      [id, 1, actor.id],
    );
    if (updated.rowCount !== 1) throw new Error("SALES_CONFIRM_CONCURRENT_WRITE");
    // Blocking audit in the SAME transaction. Failure means rollback.
    await client.query(
      `INSERT INTO erp_audit_logs
         (company_id, user_id, user_email, action, module, reference_id,
          old_data, new_data, created_at)
       VALUES ($1,$2,$3,'confirm','sales',$4,$5::jsonb,$6::jsonb,NOW())`,
      [1, actor.id, actor.email, String(id),
       JSON.stringify({ status: doc.status, kind: doc.kind, invoiceStatus: doc.invoice_status }),
       JSON.stringify({ status: "confirmed", kind: "order", invoiceStatus: "to_invoice" })],
    );
    await client.query("COMMIT");
    inTransaction = false;
    response.status(200).json({ id, kind: "order", status: "confirmed",
      invoiceStatus: "to_invoice", invoiceIssued: false });
  } catch (error) {
    if (client && inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    request.log?.error?.({ error }, "CST DEV Sales confirmation refused");
    response.status(503).json({ error: "Sales confirmation unavailable; nothing was committed" });
  } finally {
    client?.release();
  }
});

export default router;