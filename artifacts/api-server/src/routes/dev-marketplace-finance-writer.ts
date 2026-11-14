import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getProductionSession, getProductionUser, isDevelopmentEnvironment } from "./dev-auth";
// Load canonical services only after the DEV flag and verified session pass.
// Startup of PROD must not initialize Marketplace finance dependencies.
const invoiceService = () => import("../lib/services/mktVendorInvoiceService.js");
const apService = () => import("../lib/services/mktApPreparationService.js");

/** Use the unchanged upstream Marketplace vendor invoice/AP services. DEV only.
 * Never issue payment, execute settlement, or create an Accounting journal here.
 */
const router = Router();
const validId = (s: string): number | null => /^[1-9]\d{0,9}$/.test(s) ? Number(s) : null;

type VerifiedFinanceActor = { email: string; companyId: number };

/** Fail closed if the canonical finance writer still uses the shared privileged
 * database pool. This is a readiness guard, not a substitute for tenant RLS
 * policies or a dedicated connection with authenticated company binding.
 */
async function financeDatabaseRoleVerified(): Promise<boolean> {
  const result = await pool.query<{
    db_role: string;
    elevated: boolean;
    vendor_rls_active: boolean;
    ap_rls_active: boolean;
    payment_rls_active: boolean;
  }>(`select current_user::text as db_role,
           coalesce((select r.rolsuper or r.rolbypassrls
                      from pg_catalog.pg_roles r where r.rolname = current_user), true) as elevated,
           row_security_active('public.vendor_invoices'::regclass) as vendor_rls_active,
           row_security_active('public.mkt_ap_preparations'::regclass) as ap_rls_active,
           row_security_active('public.payment_requests'::regclass) as payment_rls_active`);
  const row = result.rows[0];
  return Boolean(row
    && row.db_role === "bizportal_marketplace_login_dev"
    && row.elevated === false
    && row.vendor_rls_active === true
    && row.ap_rls_active === true
    && row.payment_rls_active === true);
}

async function authorize(req: Request, res: Response): Promise<VerifiedFinanceActor | null> {
  // Bundled DEV uses NODE_ENV=production; APP_ENV alone chooses the DB target.
  // Never allow this writer on an inferred DEV or the actual PROD application.
  if (!isDevelopmentEnvironment() || process.env.APP_ENV?.trim().toLowerCase() !== "development" || process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true") {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  const session = getProductionSession(req);
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return null; }
  try {
    const user = await getProductionUser(session);
    if (!user || user.role.toLowerCase() !== "super_admin") {
      res.status(403).json({ error: "Forbidden" }); return null;
    }
    // Never authorize finance access through a role-only or unscoped identity.
    // Super Admin approvals remain single-step, but must belong to a verified company.
    const companyId = user.companyId;
    if (typeof companyId !== "number" || !Number.isSafeInteger(companyId) || companyId <= 0) {
      res.status(403).json({ error: "Company scope not verified" }); return null;
    }
    if (!(await financeDatabaseRoleVerified())) {
      res.status(503).json({ error: "DEV Finance database role/RLS not ready" }); return null;
    }
    return { email: user.email, companyId };
  } catch (error) {
    req.log?.error({ error }, "Marketplace finance session lookup failed");
    res.status(503).json({ error: "Authorization unavailable" });
    return null;
  }
}

async function verifiedInvoice(id: number, companyId: number) {
  // Validate the authenticated company before loading invoice contents.
  const result = await pool.query(
    `select p.company_id, p.vendor_id, vi.mkt_goods_receipt_id
       from public.mkt_purchase_orders p
       join public.vendor_invoices vi on vi.mkt_purchase_order_id=p.id
      where vi.id=$1 and p.company_id=$2 and vi.company_id=$2
        and p.company_id=vi.company_id and p.vendor_id=vi.supplier_id
        and vi.mkt_goods_receipt_id is not null limit 1`, [id, companyId],
  );
  if (!result.rows.length) return null;
  const detail = await (await invoiceService()).getMarketplaceVendorInvoice(id);
  if (!detail || detail.invoice.companyId !== companyId ||
      !detail.invoice.mktPurchaseOrderId || !detail.invoice.supplierId) return null;
  return detail;
}

async function verifiedAp(id: number, companyId: number) {
  // Keep all company filtering within the SQL boundary, before reading AP data.
  const result=await pool.query(
    `select ap.id from public.mkt_ap_preparations ap
       join public.vendor_invoices vi on vi.id=ap.vendor_invoice_id
       join public.mkt_purchase_orders p on p.id=ap.mkt_purchase_order_id
       join public.mkt_po_goods_receipts gr on gr.id=ap.mkt_goods_receipt_id
       join public.mkt_po_shipments sh on sh.id=gr.shipment_id
      where ap.id=$1 and ap.company_id=$2 and p.company_id=$2 and vi.company_id=$2
        and ap.company_id=p.company_id and vi.company_id=p.company_id
        and vi.mkt_purchase_order_id=p.id and vi.mkt_goods_receipt_id=gr.id
        and ap.supplier_id=p.vendor_id and vi.supplier_id=p.vendor_id
        and sh.po_id=p.id and sh.shipment_status='delivered'
        and gr.inspection_status='passed'
        and vi.status='ready_for_ap' and vi.three_way_match_status='passed'
      limit 1`,[id, companyId],
  );
  if (!result.rows.length) return null;
  const ap=await (await apService()).getApPreparation(id);
  if (!ap || ap.companyId !== companyId ||
      !ap.mktPurchaseOrderId || !ap.mktGoodsReceiptId || !ap.vendorInvoiceId) return null;
  return ap;
}

router.get("/mkt/admin/vendor-invoices/:id", async (req, res) => {
  const actor = await authorize(req, res);
  if (!actor) return;
  const id=validId(String(req.params.id ?? ""));
  if (!id) { res.status(400).json({ error: "Invalid invoice ID" }); return; }
  try {
    const detail=await verifiedInvoice(id, actor.companyId);
    if (!detail) { res.status(404).json({ error: "Invoice not linked to a valid company-scoped Marketplace PO" }); return; }
    res.json({ ok:true, data:(await invoiceService()).safeMarketplaceVendorInvoiceView(detail.invoice,detail.lines) });
  } catch(error) { req.log?.error({error},"Marketplace invoice read failed");res.status(503).json({error:"Invoice unavailable"}); }
});

router.post("/mkt/admin/vendor-invoices/:id/match", async (req,res) => {
  const actor=await authorize(req,res);
  if (!actor) return;
  const id=validId(String(req.params.id ?? ""));
  if (!id) {res.status(400).json({error:"Invalid invoice ID"});return;}
  if (req.body && Object.keys(req.body).length) {res.status(422).json({error:"INVALID_BODY"});return;}
  try {
    const detail=await verifiedInvoice(id, actor.companyId);
    if (!detail) {res.status(404).json({error:"INVOICE_COMPANY_OR_PO_INVALID"});return;}
    const result=await (await invoiceService()).submitMarketplaceVendorInvoice(id,{actorType:"admin",actorId:actor.email,actorName:actor.email});
    if (!result.ok) {res.status(result.code==="INVALID_STATUS"?409:422).json({ok:false,error:result.code});return;}
    res.json({ok:true,alreadyMatched:result.alreadyExists===true,data:(await invoiceService()).safeMarketplaceVendorInvoiceView(result.invoice,result.lines),match:result.match});
  } catch(error) {req.log?.error({error},"Marketplace invoice match failed");res.status(503).json({error:"Marketplace matching unavailable"});}
});

router.post("/mkt/admin/vendor-invoices/:id/ap-preparation", async (req,res) => {
  const actor=await authorize(req,res);
  if (!actor) return;
  const id=validId(String(req.params.id ?? ""));
  if (!id) {res.status(400).json({error:"Invalid invoice ID"});return;}
  if (req.body && Object.keys(req.body).length) {res.status(422).json({error:"INVALID_BODY"});return;}
  try {
    const detail=await verifiedInvoice(id, actor.companyId);
    if (!detail) {res.status(404).json({error:"INVOICE_COMPANY_OR_PO_INVALID"});return;}
    const result=await (await apService()).createApPreparation(id,{actorId:actor.email,actorName:actor.email});
    if (!result.ok) {res.status(result.code==="NOT_FOUND"?404:result.code==="INVALID_STATUS"?409:422).json({ok:false,error:result.code});return;}
    res.status(result.alreadyExists?200:201).json({ok:true,alreadyExists:result.alreadyExists,data:(await apService()).safeApView(result.preparation)});
  } catch(error) {req.log?.error({error},"Marketplace AP preparation failed");res.status(503).json({error:"AP preparation unavailable"});}
});

router.get("/mkt/admin/ap-preparations/:id",async(req,res)=>{
  const actor = await authorize(req, res);
  if (!actor) return;
  const id=validId(String(req.params.id ?? ""));
  if (!id) {res.status(400).json({error:"Invalid AP ID"});return;}
  try {
    const ap=await verifiedAp(id, actor.companyId);
    if (!ap) {res.status(404).json({error:"AP not found"});return;}
    res.json({ok:true,data:(await apService()).safeApView(ap)});
  } catch(error) {req.log?.error({error},"Marketplace AP read failed");res.status(503).json({error:"AP unavailable"});}
});

for (const [path, action] of [
  ["finance-review","reviewApPreparation"],
  ["waiting-payment","markApPreparationWaitingPayment"],
] as const) {
  router.post(`/mkt/admin/ap-preparations/:id/${path}`,async(req,res)=>{
    const actor=await authorize(req,res);
    if (!actor) return;
    const id=validId(String(req.params.id ?? ""));
    if (!id) {res.status(400).json({error:"Invalid AP ID"});return;}
    if (req.body && Object.keys(req.body).length) {res.status(422).json({error:"INVALID_BODY"});return;}
    try {
      const ap=await verifiedAp(id, actor.companyId);
      if (!ap) {res.status(404).json({error:"AP not found"});return;}
      const result=await (await apService())[action](id,{actorId:actor.email,actorName:actor.email});
      if (!result.ok) {res.status(result.code==="NOT_FOUND"?404:409).json({ok:false,error:result.code});return;}
      res.json({ok:true,alreadyProcessed:result.alreadyExists,data:(await apService()).safeApView(result.preparation)});
    } catch(error) {req.log?.error({error},"Marketplace AP action failed");res.status(503).json({error:"AP action unavailable"});}
  });
}
// Explicit, separately gated handoff. This only creates a DRAFT Accounting
// payment request and a durable idempotency record; never pays/posts a journal.
router.post("/mkt/admin/ap-preparations/:id/accounting-handoff", async (req,res) => {
  const actor = await authorize(req,res);
  if (!actor) return;
  if (process.env.BIZPORTAL_MARKETPLACE_ACCOUNTING_HANDOFF_ENABLED_DEV !== "true") {
    res.status(404).json({ error: "Not found" }); return;
  }
  const id = validId(String(req.params.id ?? ""));
  if (!id) { res.status(400).json({ error: "Invalid AP ID" }); return; }
  if (req.body && Object.keys(req.body).length) {
    res.status(422).json({ error: "INVALID_BODY" }); return;
  }
  try {
    const ap = await verifiedAp(id, actor.companyId);
    if (!ap) { res.status(404).json({ error: "AP not found" }); return; }
    const result = await (await apService()).createMarketplaceAccountingHandoff(id, { actorId: actor.email, actorName: actor.email });
    if (!result.ok) {
      res.status(result.code === "NOT_FOUND" ? 404 : 409).json({ ok: false, error: result.code }); return;
    }
    res.status(result.alreadyExists ? 200 : 201).json({
      ok: true, alreadyExists: result.alreadyExists,
      paymentRequestId: result.paymentRequestId, handoffId: result.handoffId,
      paymentStatus: "draft", journalPosted: false,
    });
  } catch (error) {
    req.log?.error({error},"Marketplace Accounting handoff failed");
    res.status(503).json({error:"Accounting handoff unavailable"});
  }
});

export default router;
