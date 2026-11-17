/**
 * Marketplace vendor invoice endpoints.
 *
 * Vendor access is token-scoped to the Marketplace PO. The request body never
 * supplies the authoritative vendor, company, or PO identity.
 */
import { Router } from "express";
import { z } from "zod/v4";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  withMarketplaceFinanceDevTransaction,
  vendorInvoicesTable,
} from "@workspace/db";
import { imagePdfUpload, sanitizeFilename } from "../lib/uploadMiddleware.js";
import { validateMagicBytes } from "../lib/uploadValidation.js";
import { ObjectStorageService } from "../lib/objectStorage.js";
import { validateBody } from "../lib/middleware/validateBody.js";
import { findPoByVendorToken } from "../lib/services/mktVendorPoTokenService.js";
import { resolveVendorInvoiceToken } from "../lib/services/mktVendorInvoiceTokenResolver.js";
import {
  createMarketplaceVendorInvoice,
  getMarketplaceVendorInvoice,
  safeMarketplaceVendorInvoiceView,
  submitMarketplaceVendorInvoice,
} from "../lib/services/mktVendorInvoiceService.js";
import { tokenGetRateLimiter, tokenPostRateLimiter } from "../middlewares/securityRateLimiter.js";
import { logger } from "../lib/logger.js";

const router = Router();
const upload = imagePdfUpload(20);
const storage = new ObjectStorageService();

const InvoiceLineSchema = z.object({
  poLineId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().finite().positive(),
  unitPrice: z.coerce.number().finite().nonnegative(),
  subtotal: z.coerce.number().finite().nonnegative(),
  taxAmount: z.coerce.number().finite().nonnegative().optional(),
  name: z.string().trim().max(500).optional(),
  unit: z.string().trim().max(50).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();

const InvoiceBodySchema = z.object({
  grId: z.coerce.number().int().positive(),
  vendorInvoiceRef: z.string().trim().min(1).max(120),
  invoiceDate: z.coerce.date(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
  totalAmount: z.coerce.number().finite().nonnegative(),
  taxAmount: z.coerce.number().finite().nonnegative(),
  grandTotal: z.coerce.number().finite().nonnegative(),
  notes: z.string().trim().max(4000).nullable().optional(),
  lines: z.string().min(2).transform((value, ctx) => {
    try {
      const parsed = JSON.parse(value);
      const result = z.array(InvoiceLineSchema).min(1).max(500).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({ code: "custom", message: "Format lines invoice tidak valid" });
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({ code: "custom", message: "lines harus berupa JSON array" });
      return z.NEVER;
    }
  }),
}).strict();

function tokenStatus(code: string): number {
  if (code === "MALFORMED") return 400;
  if (code === "EXPIRED") return 410;
  return 404;
}

function failureStatus(code: string): number {
  if (["PO_NOT_FOUND", "GR_NOT_FOUND", "GR_NOT_FOR_PO"].includes(code)) return 404;
  if (["COMPANY_SCOPE_INVALID", "DUPLICATE_INVOICE", "INVALID_STATUS", "SHIPMENT_NOT_DELIVERED", "RECEIPT_NOT_ACCEPTED"].includes(code)) return 409;
  if (["NO_LINES", "INVALID_LINE", "INVALID_TOTAL", "INVALID_CURRENCY", "INVALID_DATE", "INVALID_REFERENCE"].includes(code)) return 422;
  return 400;
}

async function resolveVendorPo(token: string, res: any) {
  const result = await resolveVendorInvoiceToken(token);
  if (!result.ok) {
    res.status(tokenStatus(result.code)).json({ ok: false, error: "TOKEN_INVALID", code: result.code });
    return null;
  }
  // The legacy null-company PO is not authorized for new vendor finance writes.
  if (!result.po.companyId || !result.po.vendorId) {
    res.status(409).json({ ok: false, error: "COMPANY_OR_VENDOR_UNASSIGNED" });
    return null;
  }
  return result.po;
}

type VerifiedPo = Extract<Awaited<ReturnType<typeof findPoByVendorToken>>, { ok: true }>["po"];

/** Revalidate the opaque token inside the same tenant-bound Finance session
 * used by canonical reads and writes. No client-provided company is trusted.
 */
async function withVendorFinance<T>(
  token: string, po: VerifiedPo, work: (scopedDb: typeof db) => Promise<T>,
): Promise<T | null> {
  if (!po.companyId || !po.vendorId) return null;
  return withMarketplaceFinanceDevTransaction(po.companyId, async scopedDb => {
    const current = await findPoByVendorToken(token, scopedDb);
    if (!current.ok || current.po.id !== po.id ||
        current.po.companyId !== po.companyId ||
        current.po.vendorId !== po.vendorId) return null;
    return work(scopedDb);
  });
}

function vendorFinanceUnavailable(error: unknown): boolean {
  // PostgreSQL aborts the transaction when lock contention becomes a
  // deadlock, a serialization conflict or a lock timeout. The vendor route
  // must return a temporary-unavailable response after deleting the uploaded
  // private proof, not treat these as permanent invoice validation failures.
  // Drizzle may nest the SQLSTATE inside Error.cause.
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!(current instanceof Error)) break;
    const pgCode = (current as Error & { code?: unknown }).code;
    if (pgCode === "40P01" || pgCode === "40001" || pgCode === "55P03") return true;
    if (current.message.startsWith("DEV_FINANCE_") ||
        current.message.includes("Authorization unavailable")) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

// GET /api/mkt/vendor-invoice/:token/invoices — vendor's invoices for this PO
router.get("/:token/invoices", tokenGetRateLimiter, async (req, res) => {
  try {
    const po = await resolveVendorPo(String(req.params.token ?? ""), res);
    if (!po) return;
    const views = await withVendorFinance(String(req.params.token ?? ""), po, async scopedDb => {
      const invoices = await scopedDb.select().from(vendorInvoicesTable)
        .where(and(
          eq(vendorInvoicesTable.mktPurchaseOrderId, po.id),
          eq(vendorInvoicesTable.supplierId, po.vendorId),
        ))
        .orderBy(asc(vendorInvoicesTable.id));
      return Promise.all(invoices.map(async invoice => {
        const detail = await getMarketplaceVendorInvoice(invoice.id, scopedDb);
        return safeMarketplaceVendorInvoiceView(invoice, detail?.lines ?? []);
      }));
    });
    if (!views) return res.status(404).json({ ok: false, error: "TOKEN_INVALID" });
    return res.json({ ok: true, data: views });
  } catch (err) {
    logger.warn({ err }, "[mktVendorInvoice] list invoices error");
    return res.status(vendorFinanceUnavailable(err) ? 503 : 500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /api/mkt/vendor-invoice/:token — upload/create a draft invoice
router.post("/:token", tokenPostRateLimiter, upload.single("file"), async (req, res) => {
  let objectPath: string | null = null;
  try {
    const po = await resolveVendorPo(String(req.params.token ?? ""), res);
    if (!po) return;
    const parsed = InvoiceBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(422).json({ ok: false, error: "INVALID_BODY", details: parsed.error.flatten() });
    }
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "INVOICE_FILE_REQUIRED" });
    const magic = validateMagicBytes(file.buffer, file.mimetype);
    if (!magic.ok) {
      return res.status(400).json({ ok: false, error: "INVALID_FILE", message: magic.errorMessage });
    }

    // Refuse missing/privileged DB credentials before uploading a private file.
    const token = String(req.params.token ?? "");
    const ready = await withVendorFinance(token, po, async () => true);
    if (!ready) return res.status(404).json({ ok: false, error: "TOKEN_INVALID" });
    const uploadedPath = await storage.uploadPrivateEntity(file.buffer, file.mimetype);
    objectPath = uploadedPath;
    const result = await withVendorFinance(token, po, scopedDb =>
      createMarketplaceVendorInvoice({
      poId: po.id,
      vendorToken: token,
      grId: parsed.data.grId,
      vendorInvoiceRef: parsed.data.vendorInvoiceRef,
      invoiceDate: parsed.data.invoiceDate,
      currency: parsed.data.currency,
      totalAmount: parsed.data.totalAmount,
      taxAmount: parsed.data.taxAmount,
      grandTotal: parsed.data.grandTotal,
      notes: parsed.data.notes,
      lines: parsed.data.lines,
      attachment: {
        objectPath: uploadedPath,
        fileName: sanitizeFilename(file.originalname),
        contentType: file.mimetype,
        size: file.size,
      },
      supplierId: po.vendorId,
      supplierName: po.vendorNameSnapshot ?? `Vendor ${po.vendorId}`,
      companyId: po.companyId,
      createdBy: String(po.vendorId),
    }, {
      actorType: "vendor",
      actorId: String(po.vendorId),
      actorName: po.vendorNameSnapshot,
    }, scopedDb));
    if (!result) {
      await storage.tryDeletePrivateEntity(objectPath);
      objectPath = null;
      return res.status(404).json({ ok: false, error: "TOKEN_INVALID" });
    }
    if (result.ok) {
      if (result.alreadyExists) {
        await storage.tryDeletePrivateEntity(objectPath);
        objectPath = null;
      }
      return res.status(result.alreadyExists ? 200 : 201).json({
        ok: true,
        alreadyExists: result.alreadyExists === true,
        data: safeMarketplaceVendorInvoiceView(result.invoice, result.lines),
      });
    } else {
      await storage.tryDeletePrivateEntity(objectPath);
      objectPath = null;
      return res.status(failureStatus(result.code)).json({ ok: false, error: result.code, message: result.message });
    }
  } catch (err) {
    if (objectPath) await storage.tryDeletePrivateEntity(objectPath);
    logger.warn({ err }, "[mktVendorInvoice] create invoice error");
    return res.status(vendorFinanceUnavailable(err) ? 503 : 500).json({ ok: false, error: "Internal server error" });
  }
});

// GET/POST /api/mkt/vendor-invoice/:token/invoices/:invoiceId
router.get("/:token/invoices/:invoiceId", tokenGetRateLimiter, async (req, res) => {
  try {
    const po = await resolveVendorPo(String(req.params.token ?? ""), res);
    if (!po) return;
    const invoiceId = Number(req.params.invoiceId);
    const detail = Number.isInteger(invoiceId)
      ? await withVendorFinance(String(req.params.token ?? ""), po, scopedDb =>
          getMarketplaceVendorInvoice(invoiceId, scopedDb))
      : null;
    if (!detail || detail.invoice.companyId !== po.companyId ||
        detail.invoice.mktPurchaseOrderId !== po.id || detail.invoice.supplierId !== po.vendorId) {
      return res.status(404).json({ ok: false, error: "INVOICE_NOT_FOUND" });
    }
    return res.json({ ok: true, data: safeMarketplaceVendorInvoiceView(detail.invoice, detail.lines) });
  } catch (err) {
    logger.warn({ err }, "[mktVendorInvoice] get invoice error");
    return res.status(vendorFinanceUnavailable(err) ? 503 : 500).json({ ok: false, error: "Internal server error" });
  }
});

router.post("/:token/invoices/:invoiceId/submit", tokenPostRateLimiter, validateBody(z.object({}).strict()), async (req, res) => {
  try {
    const po = await resolveVendorPo(String(req.params.token ?? ""), res);
    if (!po) return;
    const invoiceId = Number(req.params.invoiceId);
    const result = Number.isInteger(invoiceId)
      ? await withVendorFinance(String(req.params.token ?? ""), po, async scopedDb => {
          const detail = await getMarketplaceVendorInvoice(invoiceId, scopedDb);
          if (!detail || detail.invoice.companyId !== po.companyId ||
              detail.invoice.mktPurchaseOrderId !== po.id || detail.invoice.supplierId !== po.vendorId)
            return null;
          return submitMarketplaceVendorInvoice(invoiceId, {
            actorType: "vendor",
            actorId: String(po.vendorId),
            actorName: po.vendorNameSnapshot,
          }, scopedDb);
        })
      : null;
    if (!result) return res.status(404).json({ ok: false, error: "INVOICE_NOT_FOUND" });
    if (result.ok) {
      return res.json({
        ok: true,
        alreadySubmitted: result.alreadyExists === true,
        data: safeMarketplaceVendorInvoiceView(result.invoice, result.lines),
        match: result.match,
      });
    }
    return res.status(failureStatus(result.code)).json({ ok: false, error: result.code, message: result.message });
  } catch (err) {
    logger.warn({ err }, "[mktVendorInvoice] submit invoice error");
    return res.status(vendorFinanceUnavailable(err) ? 503 : 500).json({ ok: false, error: "Internal server error" });
  }
});

export default router;
