/**
 * Narrow DEV-only adapter for the original upstream Purchase PDF renderer.
 * Reuses the canonical purchase_documents and the existing document-template
 * app_config. No new document, payment, or accounting writer is introduced.
 */
import { Router, type IRouter } from "express";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pool } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";
import { isDevelopmentEnvironment } from "./dev-auth";
import { buildInvoicePdfBuffer, type InvoiceData } from "../lib/pdfInvoice.js";

const router: IRouter = Router();
const PREFIX = "bizportal_dev_document_template_v1:";
const CST_VENUE =
  "GEDUNG SPORT CENTER\nBandar Udara Internasional Soekarno–Hatta, Jl. C3 No.831, " +
  "RT.001/RW.010, Pajang, Kec. Benda, Kota Tangerang, Banten 15126";

type Company = {
  id: number; company_name: string | null; name: string | null;
  company_code: string | null; address: string | null;
  phone: string | null; email: string | null;
};
type Purchase = {
  id: number; doc_number: string; kind: string; status: string;
  supplier_name: string; supplier_address: string | null;
  created_at: Date | string; grand_total: string | number;
  total_amount: string | number; tax_amount: string | number | null;
  notes: string | null;
};
type PurchaseLine = {
  name: string; description: string | null; quantity: string | number;
  unit_cost: string | number; subtotal: string | number;
};

function safeSettings(raw: string | undefined): Record<string, unknown> {
  try {
    const obj: unknown = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
function readString(data: Record<string, unknown>, key: string, maximum = 500): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

router.get("/purchase/documents/:id/pdf", async (req: AdminRequest, res, next) => {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      !isDevelopmentEnvironment() ||
      process.env.BIZPORTAL_DOCUMENT_TEMPLATES_ENABLED_DEV !== "true") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await authenticateAdmin(req, res, next);
}, async (req: AdminRequest, res) => {
  const companyId = req.adminUser?.companyId;
  if (req.query.companyId !== undefined && Number(req.query.companyId) !== companyId) {
    res.status(403).json({ error: "Company scope mismatch" });
    return;
  }
  if (typeof companyId !== "number" || !Number.isSafeInteger(companyId) || companyId <= 0) {
    res.status(403).json({ error: "Company scope not verified" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid purchase document ID" });
    return;
  }
  try {
    const companyResult = await pool.query<Company>(
      "select id,company_name,name,company_code,address,phone,email from public.companies " +
      "where id=$1 and coalesce(is_active,true)=true limit 1", [companyId]);
    const company = companyResult.rows[0];
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const docResult = await pool.query<Purchase>(
      "select id,doc_number,kind,status,supplier_name,supplier_address,created_at," +
      "grand_total,total_amount,tax_amount,notes from public.purchase_documents " +
      "where id=$1 and company_id=$2 and kind in ('order','rfq') limit 1",
      [id, companyId]);
    const po = docResult.rows[0];
    if (!po) {
      res.status(404).json({ error: "Purchase document not found" });
      return;
    }
    const [itemResult, templateResult] = await Promise.all([
      pool.query<PurchaseLine>(
        "select l.name,l.description,l.quantity,l.unit_cost,l.subtotal " +
        "from public.purchase_document_lines l join public.purchase_documents p on p.id=l.document_id " +
        "where p.id=$1 and p.company_id=$2 and p.kind in ('order','rfq') " +
        "order by l.id asc limit 201", [id,companyId]),
      pool.query<{value:string}>(
        "select value from public.app_config where key=$1 and environment='development' " +
        "and is_secret=false limit 1",
        [PREFIX + companyId + ":" + (po.kind === "order" ? "po" : "quotation")]),
    ]);
    if (itemResult.rows.length > 200) {
      res.status(422).json({ error: "Document exceeds PDF line limit" });
      return;
    }
    const settings = safeSettings(templateResult.rows[0]?.value);
    const isCst = company.company_code?.trim().toUpperCase() === "CST";
    // Trust only the bundled official CST asset. Never fetch external logos in PDF generation.
    const bundledLogo = resolvePath(process.cwd(), "dist/public/cst-logo.png");
    const staticLogo = isCst && existsSync(bundledLogo) ? readFileSync(bundledLogo) : null;
    const companyName = company.company_name || company.name || "";
    const companyAddress = isCst ? CST_VENUE : company.address || "";
    const template = {
      documentType: po.kind === "order" ? "po" : "quotation",
      companyName, companyAddress,
      companyPhone: company.phone || "",
      companyEmail: company.email || "",
      primaryColor: /^#[a-f0-9]{6}$/i.test(String(settings.primaryColor)) ?
        String(settings.primaryColor) : "#1e3a6e",
      accentColor: /^#[a-f0-9]{6}$/i.test(String(settings.accentColor)) ?
        String(settings.accentColor) : "#2563eb",
      footerText: readString(settings,"footerText") || "Dicetak otomatis oleh BizPortal",
      defaultTerms: readString(settings,"defaultTerms",2000) || "",
      defaultNotes: readString(settings,"defaultNotes",2000) || "",
      headerText: readString(settings,"headerText") || "",
      fontSize: Number.isSafeInteger(settings.fontSize) &&
        Number(settings.fontSize) >= 8 && Number(settings.fontSize) <= 20 ?
        Number(settings.fontSize) : 11,
      showSignature: settings.showSignature === true,
      showStamp: settings.showStamp === true,
    };
    const data: InvoiceData = {
      title: po.kind === "order" ? "PURCHASE ORDER" : "REQUEST FOR QUOTATION",
      docNumber: po.doc_number, kind: po.kind, status: po.status,
      companyName, companyAddress,
      partyLabel: "Vendor", partyName: po.supplier_name,
      partyAddress: po.supplier_address || undefined,
      createdAt: new Date(po.created_at).toISOString(),
      lines: itemResult.rows.map(line => ({
        name: line.name, description: line.description,
        quantity: Number(line.quantity), unitPrice: Number(line.unit_cost),
        subtotal: Number(line.subtotal),
      })),
      totalAmount: Number(po.total_amount), taxAmount: Number(po.tax_amount ?? 0),
      grandTotal: Number(po.grand_total), notes: po.notes,
      template, staticCompanyLogo: staticLogo,
    };
    const pdf = await buildInvoicePdfBuffer(data);
    const safeName = po.doc_number.replace(/[^A-Za-z0-9_.-]/g,"_").slice(0,90);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}.pdf"`);
    res.setHeader("Cache-Control","private, no-store");
    res.setHeader("Content-Length", String(pdf.length));
    res.send(pdf);
  } catch (error) {
    req.log?.error?.({ error }, "DEV purchase binary PDF failed");
    if (!res.headersSent) res.status(503).json({ error: "Purchase PDF unavailable" });
  }
});
export default router;
