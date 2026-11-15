import { Router, type Request, type Response } from "express";
import { db, withMarketplaceFinanceDevTransaction } from "@workspace/db";
import { sql } from "drizzle-orm";
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
    return { email: user.email, companyId };
  } catch (error) {
    req.log?.error({ error }, "Marketplace finance session lookup failed");
    res.status(503).json({ error: "Authorization unavailable" });
    return null;
  }
}

async function verifiedInvoice(id: number, companyId: number, scopedDb: typeof db) {
  // Validate tenant scope in the same restricted transaction used for detail.
  const result = await scopedDb.execute(sql`
    select p.company_id, p.vendor_id, vi.mkt_goods_receipt_id
      from public.mkt_purchase_orders p
      join public.vendor_invoices vi on vi.mkt_purchase_order_id=p.id
     where vi.id=${id} and p.company_id=${companyId} and vi.company_id=${companyId}
       and p.company_id=vi.company_id and p.vendor_id=vi.supplier_id
       and vi.mkt_goods_receipt_id is not null limit 1
  `);
  if (!result.rows.length) return null;
  const detail = await (await invoiceService()).getMarketplaceVendorInvoice(id, scopedDb);
  if (!detail || detail.invoice.companyId !== companyId ||
      !detail.invoice.mktPurchaseOrderId || !detail.invoice.supplierId) return null;
  return detail;
}

async function verifiedAp(id: number, companyId: number, scopedDb: typeof db) {
  // The verification and canonical AP read share the same restricted session.
  const result = await scopedDb.execute(sql`
    select ap.id from public.mkt_ap_preparations ap
      join public.vendor_invoices vi on vi.id=ap.vendor_invoice_id
      join public.mkt_purchase_orders p on p.id=ap.mkt_purchase_order_id
      join public.mkt_po_goods_receipts gr on gr.id=ap.mkt_goods_receipt_id
      join public.mkt_po_shipments sh on sh.id=gr.shipment_id
     where ap.id=${id} and ap.company_id=${companyId}
       and p.company_id=${companyId} and vi.company_id=${companyId}
       and ap.company_id=p.company_id and vi.company_id=p.company_id
       and vi.mkt_purchase_order_id=p.id and vi.mkt_goods_receipt_id=gr.id
       and ap.supplier_id=p.vendor_id and vi.supplier_id=p.vendor_id
       and sh.po_id=p.id and sh.shipment_status='delivered'
       and gr.inspection_status='passed'
       and vi.status='ready_for_ap' and vi.three_way_match_status='passed'
     limit 1
  `);
  if (!result.rows.length) return null;
  const ap = await (await apService()).getApPreparation(id, scopedDb);
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
    const detail=await withMarketplaceFinanceDevTransaction(actor.companyId, scopedDb => verifiedInvoice(id, actor.companyId, scopedDb));
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
    const result=await withMarketplaceFinanceDevTransaction(actor.companyId, async scopedDb => {
      const detail=await verifiedInvoice(id, actor.companyId, scopedDb);
      if (!detail) return null;
      return (await invoiceService()).submitMarketplaceVendorInvoice(
        id,{actorType:"admin",actorId:actor.email,actorName:actor.email},scopedDb,
      );
    });
    if (!result) {res.status(404).json({error:"INVOICE_COMPANY_OR_PO_INVALID"});return;}
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
    const result=await withMarketplaceFinanceDevTransaction(actor.companyId, async scopedDb => {
      const detail=await verifiedInvoice(id, actor.companyId, scopedDb);
      if (!detail) return null;
      return (await apService()).createApPreparation(
        id,{actorId:actor.email,actorName:actor.email},scopedDb,
      );
    });
    if (!result) {res.status(404).json({error:"INVOICE_COMPANY_OR_PO_INVALID"});return;}
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
    const ap=await withMarketplaceFinanceDevTransaction(actor.companyId, scopedDb => verifiedAp(id, actor.companyId, scopedDb));
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
      const result=await withMarketplaceFinanceDevTransaction(actor.companyId, async scopedDb => {
        const ap=await verifiedAp(id, actor.companyId, scopedDb);
        if (!ap) return null;
        return (await apService())[action](id,{actorId:actor.email,actorName:actor.email},scopedDb);
      });
      if (!result) {res.status(404).json({error:"AP not found"});return;}
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
    const result = await withMarketplaceFinanceDevTransaction(actor.companyId, async scopedDb => {
      const ap=await verifiedAp(id, actor.companyId, scopedDb);
      if (!ap) return null;
      return (await apService()).createMarketplaceAccountingHandoff(
        id,{actorId:actor.email,actorName:actor.email},scopedDb,
      );
    });
    if (!result) { res.status(404).json({ error: "AP not found" }); return; }
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
