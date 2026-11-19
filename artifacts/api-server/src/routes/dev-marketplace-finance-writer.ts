import { Router, type Request, type Response } from "express";
import { db, pool, withMarketplaceFinanceDevTransaction, withMarketplaceFinanceDevReadOnlyTransaction } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  getProductionSession, getProductionUser, isDevelopmentEnvironment,
  getFinanceCompanyScope, isApprovedFinanceGlobalSuperAdmin, isApprovedFinanceGlobalCompany,
  isFinanceGlobalScopeDevEnabled, setFinanceCompanyScopeCookie,
} from "./dev-auth";
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

async function isActiveFinanceCompany(companyId: number): Promise<boolean> {
  const result = await pool.query<{ id: number }>(
    "select id from public.companies where id=$1 and coalesce(is_active,true)=true limit 1",
    [companyId],
  );
  return result.rows.length === 1;
}

// Explicit, audited company selection only for allowlisted GLOBAL Super Admin.
// A frontend localStorage value, query string or x-company-id header is never a grant.
router.post("/mkt/admin/finance-company-selection", async (req, res) => {
  if (!isDevelopmentEnvironment() || process.env.APP_ENV?.trim().toLowerCase() !== "development"
    || !isFinanceGlobalScopeDevEnabled()) {
    res.status(404).json({ error: "Not found" }); return;
  }
  const session = getProductionSession(req);
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const user = await getProductionUser(session);
    if (!user || user.role.toLowerCase() !== "super_admin"
      || user.companyId !== null || !isApprovedFinanceGlobalSuperAdmin(user.email)) {
      res.status(403).json({ error: "Global Finance access not approved" }); return;
    }
    // The existing signed session is required, and cross-site browser requests
    // cannot use this endpoint to silently switch the Finance company.
    const fetchSite = req.header("sec-fetch-site");
    // A forged or foreign browser Origin must not switch tenant scope even
    // when Sec-Fetch-Site is missing or spoofed. Use the actual HTTP Host,
    // not caller-controlled X-Forwarded-Host, as the host reference.
    const origin = req.header("origin");
    let validOrigin = true;
    if (origin) {
      try {
        const parsed = new URL(origin);
        const presentedHost = req.header("host");
        const forwardedProtocol = req.header("x-forwarded-proto")?.split(",")[0].trim();
        const requestProtocol = forwardedProtocol || (req.secure ? "https" : "http");
        validOrigin = parsed.origin === origin
          && parsed.host.toLowerCase() === presentedHost?.toLowerCase()
          && parsed.protocol === requestProtocol.toLowerCase() + ":";
      } catch { validOrigin = false; }
    }
    if (!validOrigin || (fetchSite && fetchSite !== "same-origin") || !req.is("application/json")) {
      res.status(403).json({ error: "Same-origin JSON request required" }); return;
    }
    const body = req.body;
    const companyId = body?.companyId;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1
      || !Number.isSafeInteger(companyId) || companyId <= 0) {
      res.status(422).json({ error: "Invalid company selection" }); return;
    }
    if (!isApprovedFinanceGlobalCompany(companyId)) {
      res.status(403).json({ error: "Finance company not in allowlist" }); return;
    }
    if (!await isActiveFinanceCompany(companyId)) {
      res.status(404).json({ error: "Company unavailable" }); return;
    }
    // The independent read-only GET mode must not write through the auth DB:
    // this restricted Admin role intentionally lacks the Finance audit INSERT
    // policy. Retain the existing durable audit contract for the Writer mode.
    if (process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV !== "true"
        && process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV === "true") {
      req.log?.info?.({ companyId, actorId: user.id }, "DEV Finance read-only company selected");
    } else {
      // Fail closed if the Writer-mode audit cannot be persisted.
      await pool.query(
        "insert into public.audit_logs "
        + "(user_email,action,entity_type,entity_id,after_data,ip_address,company_id,module) "
        + "values ($1,'finance_company_scope_selected','company',$2,$3::jsonb,$4,$5,'marketplace_finance')",
        [user.email, String(companyId),
          JSON.stringify({ selectedCompanyId: companyId, source: "signed_dev_superadmin" }),
          req.ip ?? null, String(companyId)],
      );
    }
    setFinanceCompanyScopeCookie(res, session, companyId);
    res.json({ ok: true, companyId });
  } catch (error) {
    req.log?.error({ error }, "Global Finance company selection unavailable");
    res.status(503).json({ error: "Finance company selection unavailable" });
  }
});

async function authorize(req: Request, res: Response, readOnly = false): Promise<VerifiedFinanceActor | null> {
  // Separate opt-in GET-only gate; POST actions still require the Writer flag.
  const writerEnabled = process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV === "true";
  const readerEnabled = readOnly && process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV === "true";
  if (!isDevelopmentEnvironment() || process.env.APP_ENV?.trim().toLowerCase() !== "development"
    || (!writerEnabled && !readerEnabled)) {
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
    // Existing company-bound Super Admin continues unchanged. Only explicitly
    // allowlisted global Super Admin may use a time-limited, session-bound scope.
    let companyId = user.companyId;
    if (companyId === null && isApprovedFinanceGlobalSuperAdmin(user.email)) {
      const selected = getFinanceCompanyScope(req, session);
      if (selected !== null && isApprovedFinanceGlobalCompany(selected)
        && await isActiveFinanceCompany(selected)) {
        companyId = selected;
      }
    }
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

// Exact GET-only Finance DEV list. Unlike the legacy Purchase workflow list,
// this uses the signed Finance scope cookie and the restricted company DB role.
router.get("/mkt/admin/vendor-invoices", async (req, res) => {
  const actor = await authorize(req, res, true);
  if (!actor) return;
  const allowed = new Set(["company", "page", "pageSize"]);
  const values = Object.entries(req.query);
  if (values.some(([key, val]) => !allowed.has(key) || typeof val !== "string")) {
    res.status(400).json({ error: "Invalid invoice list parameters" }); return;
  }
  const requestedCompany = req.query.company;
  if (requestedCompany !== undefined && requestedCompany !== String(actor.companyId)) {
    res.status(403).json({ error: "Finance company scope mismatch" }); return;
  }
  const parseBounded = (input: unknown, fallback: number, max: number): number | null => {
    if (input === undefined) return fallback;
    if (typeof input !== "string" || !/^[1-9][0-9]*$/.test(input)) return null;
    const n = Number(input);
    return Number.isSafeInteger(n) && n <= max ? n : null;
  };
  const page = parseBounded(req.query.page, 1, 10000);
  const pageSize = parseBounded(req.query.pageSize, 50, 100);
  if (page === null || pageSize === null) {
    res.status(400).json({ error: "Invalid invoice pagination" }); return;
  }
  const offset = (page - 1) * pageSize;
  try {
    const result = await withMarketplaceFinanceDevReadOnlyTransaction(actor.companyId, async scopedDb => {
      // Canonical PO-backed invoices only; no privileged auth-DB fallback.
      const count = await scopedDb.execute(sql`
        select count(*)::integer total from public.vendor_invoices vi
        join public.mkt_purchase_orders po on po.id=vi.mkt_purchase_order_id
        where vi.company_id=${actor.companyId} and po.company_id=${actor.companyId}
          and po.vendor_id=vi.supplier_id`);
      const rows = await scopedDb.execute(sql`
        select vi.id, vi.invoice_number, vi.vendor_invoice_ref, vi.supplier_name,
          vi.status::text status, vi.grand_total, vi.three_way_match_status,
          vi.company_id, vi.invoice_date
        from public.vendor_invoices vi
        join public.mkt_purchase_orders po on po.id=vi.mkt_purchase_order_id
        where vi.company_id=${actor.companyId} and po.company_id=${actor.companyId}
          and po.vendor_id=vi.supplier_id
        order by vi.created_at desc nulls last, vi.id desc
        limit ${pageSize} offset ${offset}`);
      return { total: Number(count.rows[0]?.total ?? 0), rows: rows.rows };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      data: result.rows.map((r: any) => ({
        id:r.id, invoiceNumber:r.invoice_number, vendorInvoiceRef:r.vendor_invoice_ref,
        supplierName:r.supplier_name, status:r.status, grandTotal:Number(r.grand_total),
        amountPaid:null, reconciledAmountPaid:null, threeWayMatchStatus:r.three_way_match_status,
        companyId:r.company_id, invoiceDate:r.invoice_date,
        journalStatus:null, withholdingTaxAmount:null, withholdingTaxType:null,
        invoiceBreakdown:null, pphPaidAmount:null,
      })),
      page, pageSize, total: result.total, hasMore:offset+result.rows.length<result.total,
      mode:"canonical_finance_dev_read_only",
    });
  } catch (error) {
    req.log?.error?.({ errorCode: "FINANCE_LIST_READ_FAILED" }, "Finance company invoice list unavailable");
    res.status(503).json({ error:"Finance invoice list unavailable" });
  }
});

router.get("/mkt/admin/vendor-invoices/:id", async (req, res) => {
  const actor = await authorize(req, res, true);
  if (!actor) return;
  const id=validId(String(req.params.id ?? ""));
  if (!id) { res.status(400).json({ error: "Invalid invoice ID" }); return; }
  try {
    const detail=await withMarketplaceFinanceDevReadOnlyTransaction(actor.companyId, scopedDb => verifiedInvoice(id, actor.companyId, scopedDb));
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
  const actor = await authorize(req, res, true);
  if (!actor) return;
  const id=validId(String(req.params.id ?? ""));
  if (!id) {res.status(400).json({error:"Invalid AP ID"});return;}
  try {
    const ap=await withMarketplaceFinanceDevReadOnlyTransaction(actor.companyId, scopedDb => verifiedAp(id, actor.companyId, scopedDb));
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
