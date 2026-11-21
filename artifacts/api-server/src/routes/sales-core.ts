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
// Non-sensitive route presence receipt for anonymous CI/runtime probes.
// The actual document data remains protected by authenticateAdmin and signed OTP.
router.use((request, response, next) => {
  if (request.method === "GET" && request.path === "/sales/documents/108" &&
      isDevelopmentEnvironment() && process.env.APP_ENV === "development") {
    response.setHeader("X-CST-DEV-Sales-Detail-Reader", "v2");
  }
  next();
});

router.use(authenticateAdmin);

// DEV-only read parity for the exact synthetic Order #108.
// The old UI queries GET /sales/documents/:id, which the canonical DEV router
// did not expose. No legacy writer or Invoice route is imported here.
router.get("/sales/documents/:id", async (request, response): Promise<void> => {
  // Reading a document is not a customer-creation permission. Keep the
  // QA provisioning flag only on the distinct POST and capability endpoints.
  if (request.params.id !== "108" ||
      !isDevelopmentEnvironment() || process.env.APP_ENV !== "development" ||
      !isSignedOtpDevEnabled()) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const session = getProductionSession(request);
  const actor = session ? await getProductionUser(session).catch(() => null) : null;
  if (!session || !actor || actor.id !== session.id ||
      actor.email.trim().toLowerCase() !== session.email ||
      actor.role !== "super_admin" ||
      (actor.companyId !== null && Number(actor.companyId) !== 1)) {
    response.status(403).json({ error: "Signed CST Super Admin OTP session required" });
    return;
  }
  try {
    const order = await pool.query<{
      id: number; doc_number: string; kind: string; status: string;
      invoice_status: string; delivery_status: string; payment_status: string;
      customer_id: number | null; customer_name: string; total_amount: string;
      tax_rate_id: number | null; tax_amount: string; grand_total: string;
      origin: string | null; destination: string | null;
      transport_mode: string | null; etd: Date | null; eta: Date | null;
      valid_until: Date | null; expected_date: Date | null; notes: string | null;
      confirmed_at: Date | null; amount_paid: string;
      created_at: Date; updated_at: Date;
      ai_generated: boolean; ai_source_wa_phone: string | null;
      ai_source_correspondence_id: number | null;
    }>(
      `SELECT id,doc_number,kind::text,status::text,invoice_status::text,
              delivery_status::text,payment_status::text,customer_id,customer_name,
              total_amount,tax_rate_id,tax_amount,grand_total,origin,destination,
              transport_mode,etd,eta,valid_until,expected_date,notes,confirmed_at,
              amount_paid,created_at,updated_at,ai_generated,ai_source_wa_phone,
              ai_source_correspondence_id
         FROM public.sales_documents
        WHERE id=$1 AND company_id=$2 AND doc_number=$3
          AND kind::text='order'`,
      [108, 1, "QA-CST-DEV-OWNER-20261120-001"],
    );
    const doc = order.rows[0];
    if (!doc) {
      response.status(404).json({ error: "QA Sales Order #108 not found" });
      return;
    }
    const lines = await pool.query<{
      id: number; document_id: number; product_id: number | null;
      name: string; description: string | null;
      quantity: string; unit_price: string; subtotal: string;
    }>(
      `SELECT id,document_id,product_id,name,description,quantity,unit_price,subtotal
         FROM public.sales_document_lines WHERE document_id=$1 ORDER BY id`,
      [108],
    );
    response.setHeader("Cache-Control", "no-store");
    response.json({
      id: doc.id, docNumber: doc.doc_number,
      kind: doc.kind, status: doc.status, invoiceStatus: doc.invoice_status,
      deliveryStatus: doc.delivery_status, paymentStatus: doc.payment_status,
      customerId: doc.customer_id, customerName: doc.customer_name,
      customerAddress: null, totalAmount: numeric(doc.total_amount),
      taxRateId: doc.tax_rate_id, taxAmount: numeric(doc.tax_amount),
      grandTotal: numeric(doc.grand_total), origin: doc.origin,
      destination: doc.destination, transportMode: doc.transport_mode,
      etd: isoDate(doc.etd), eta: isoDate(doc.eta),
      validUntil: isoDate(doc.valid_until), expectedDate: isoDate(doc.expected_date),
      notes: doc.notes, confirmedAt: isoDate(doc.confirmed_at),
      amountPaid: numeric(doc.amount_paid),
      createdAt: isoDate(doc.created_at), updatedAt: isoDate(doc.updated_at),
      aiGenerated: doc.ai_generated, aiSourceWaPhone: doc.ai_source_wa_phone,
      aiSourceCorrespondenceId: doc.ai_source_correspondence_id,
      lines: lines.rows.map(line => ({
        id: line.id, documentId: line.document_id, productId: line.product_id,
        name: line.name, description: line.description,
        quantity: numeric(line.quantity), unitPrice: numeric(line.unit_price),
        subtotal: numeric(line.subtotal),
      })),
    });
  } catch (error) {
    request.log?.error?.({ error }, "CST-DEV QA Sales Order #108 read unavailable");
    response.status(503).json({ error: "QA Sales Order read unavailable" });
  }
});


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


/**
 * Explicit, single-order synthetic Customer setup for Invoice #108 E2E QA.
 * This is an application workflow (not an operator SQL data patch).
 * Only CST-DEV, default OFF, signed OTP Super Admin and exact QA reference.
 * No Invoice creation, journal posting, finance activation, or side effects
 * outside the one Customer and Sales Order identity + transactional audit.
 */
// Capability is read-only and reveals no customer data. It prevents a dead QA
// button appearing before signed OTP authentication and the DEV flag are ready.
router.get("/sales/dev/qa-orders/108/customer-setup-capability", async (request, response): Promise<void> => {
  if (!isDevelopmentEnvironment() || process.env.APP_ENV !== "development" ||
      !isSignedOtpDevEnabled() ||
      process.env.BIZPORTAL_DEV_QA_ORDER108_CUSTOMER_SETUP !== "true") {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const session = getProductionSession(request);
  const actor = session ? await getProductionUser(session).catch(() => null) : null;
  if (!session || !actor || actor.id !== session.id ||
      actor.email.trim().toLowerCase() !== session.email ||
      actor.role !== "super_admin" ||
      (actor.companyId !== null && Number(actor.companyId) !== 1)) {
    response.status(403).json({ error: "Signed CST Super Admin session required" });
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  response.json({ available: true, documentId: 108, companyId: 1, syntheticOnly: true });
});

router.post("/sales/dev/qa-orders/108/attach-customer", async (request, response): Promise<void> => {
  if (!isDevelopmentEnvironment() || process.env.APP_ENV !== "development" ||
      !isSignedOtpDevEnabled() ||
      process.env.BIZPORTAL_DEV_QA_ORDER108_CUSTOMER_SETUP !== "true") {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const session = getProductionSession(request);
  const actor = session ? await getProductionUser(session).catch(() => null) : null;
  if (!session || !actor || actor.id !== session.id ||
      actor.email.trim().toLowerCase() !== session.email ||
      actor.role !== "super_admin" ||
      (actor.companyId !== null && Number(actor.companyId) !== 1)) {
    response.status(403).json({ error: "Signed CST Super Admin session required" });
    return;
  }

  let client: PayrollDbClient | undefined;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    const result = await client.query<{
      id: number; company_id: number; customer_id: number | null;
      status: string; invoice_status: string; doc_number: string; customer_name: string;
    }>(
      `SELECT id,company_id,customer_id,status::text,invoice_status::text,doc_number,customer_name
       FROM public.sales_documents WHERE id=108 AND company_id=1 FOR UPDATE`,
    );
    const doc = result.rows[0];
    const expected = "INTERNAL QA CST DEV — NO REAL CUSTOMER";
    if (!doc || doc.doc_number !== "QA-CST-DEV-OWNER-20261120-001" ||
        doc.status !== "draft" || doc.invoice_status !== "none" ||
        doc.customer_name !== expected) {
      await client.query("ROLLBACK");
      inTransaction = false;
      response.status(409).json({ error: "QA Order #108 identity/state mismatch" });
      return;
    }
    if (doc.customer_id !== null) {
      await client.query("ROLLBACK");
      inTransaction = false;
      response.status(409).json({ error: "QA Order #108 already has a customer; no duplicate created" });
      return;
    }

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO public.customers (company_id, name, notes)
       VALUES (1,$1,$2) RETURNING id`,
      [expected, "SYNTHETIC DEV-ONLY INVOICE QA #108. Not a real customer. No external billing."],
    );
    const customerId = inserted.rows[0]?.id;
    if (!Number.isSafeInteger(customerId) || !customerId || customerId <= 0)
      throw new Error("QA_CUSTOMER_CREATE_FAILED");
    const linked = await client.query(
      `UPDATE public.sales_documents SET customer_id=$1, updated_at=NOW()
       WHERE id=108 AND company_id=1 AND customer_id IS NULL
         AND status::text='draft' AND invoice_status::text='none'
       RETURNING id`,
      [customerId],
    );
    if (linked.rowCount !== 1) throw new Error("QA_ORDER_LINK_CONFLICT");
    await client.query(
      `INSERT INTO erp_audit_logs
       (company_id,user_id,user_email,action,module,reference_id,
        old_data,new_data,created_at)
       VALUES (1,$1,$2,'update','sales','108',$3::jsonb,$4::jsonb,NOW())`,
      [actor.id, actor.email, JSON.stringify({ customerId: null }),
       JSON.stringify({ customerId, synthetic: true, qaOnly: true })],
    );
    await client.query("COMMIT");
    inTransaction = false;
    response.status(200).json({ salesDocumentId: 108, customerId, companyId: 1, synthetic: true });
  } catch (error) {
    if (client && inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    request.log?.error?.({ error }, "DEV-only QA Order #108 customer setup rolled back");
    response.status(503).json({ error: "QA customer setup unavailable; transaction rolled back" });
  } finally {
    client?.release();
  }
});

export default router;