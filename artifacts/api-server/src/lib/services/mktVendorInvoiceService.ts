import {
  db,
  onMarketplaceFinanceCommit,
  mktPoGoodsReceiptItemsTable,
  mktPoGoodsReceiptsTable,
  mktPoShipmentItemsTable,
  mktPoShipmentsTable,
  mktPurchaseOrderLinesTable,
  mktPurchaseOrdersTable,
  vendorInvoiceLinesTable,
  vendorInvoicesTable,
} from "@workspace/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { logActivity } from "../activityLog.js";
import { enqueueNotification } from "./marketplaceNotificationQueueService.js";
import type { ActorInfo } from "./mktPoLifecycleService.js";

const MONEY_TOLERANCE = 0.01;
const QTY_TOLERANCE = 0.005;

type InvoiceRow = typeof vendorInvoicesTable.$inferSelect;
type InvoiceLineRow = typeof vendorInvoiceLinesTable.$inferSelect;

export interface VendorInvoiceLineInput {
  poLineId: number;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  taxAmount?: number;
  name?: string;
  unit?: string;
  notes?: string | null;
}

export interface CreateMarketplaceVendorInvoiceInput {
  poId: number;
  grId: number;
  vendorInvoiceRef: string;
  vendorToken?: string; // passed only by the verified vendor-token route
  invoiceDate: Date;
  currency: string;
  totalAmount: number;
  taxAmount: number;
  grandTotal: number;
  notes?: string | null;
  lines: VendorInvoiceLineInput[];
  attachment: {
    objectPath: string;
    fileName: string;
    contentType: string;
    size: number;
  };
  supplierId: number;
  supplierName: string;
  companyId?: number | null;
  createdBy?: string | null;
}

type FailureCode =
  | "PO_NOT_FOUND"
  | "PO_CANCELLED"
  | "COMPANY_SCOPE_INVALID"
  | "GR_NOT_FOUND"
  | "GR_NOT_FOR_PO"
  | "DUPLICATE_INVOICE"
  | "NO_LINES"
  | "INVALID_LINE"
  | "INVALID_TOTAL"
  | "INVALID_CURRENCY"
  | "INVALID_DATE"
  | "INVALID_REFERENCE"
  | "SHIPMENT_NOT_DELIVERED"
  | "RECEIPT_NOT_ACCEPTED"
  | "INVALID_STATUS"
  | "MATCH_FAILED"
  | "CONCURRENT_UPDATE";

export type InvoiceServiceResult =
  | { ok: true; invoice: InvoiceRow; lines: InvoiceLineRow[]; alreadyExists?: boolean }
  | { ok: false; code: FailureCode; message?: string; details?: unknown };

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function closeEnough(a: number, b: number, tolerance = MONEY_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance;
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function newInvoiceNumber(): string {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `MKT-VI-${yyyymm}-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

export function safeMarketplaceVendorInvoiceView(
  invoice: InvoiceRow,
  lines: InvoiceLineRow[] = [],
) {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    vendorInvoiceRef: invoice.vendorInvoiceRef,
    supplierId: invoice.supplierId,
    supplierName: invoice.supplierName,
    mktPurchaseOrderId: invoice.mktPurchaseOrderId,
    mktGoodsReceiptId: invoice.mktGoodsReceiptId,
    status: invoice.status,
    invoiceDate: invoice.invoiceDate,
    currency: invoice.currency,
    totalAmount: invoice.totalAmount,
    taxAmount: invoice.taxAmount,
    grandTotal: invoice.grandTotal,
    threeWayMatchStatus: invoice.threeWayMatchStatus,
    attachment: invoice.attachmentFileName
      ? {
          fileName: invoice.attachmentFileName,
          contentType: invoice.attachmentContentType,
          size: invoice.attachmentSize,
        }
      : null,
    lines: lines.map((line) => ({
      id: line.id,
      poLineId: line.mktPurchaseOrderLineId,
      name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      unitCost: line.unitCost,
      subtotal: line.subtotal,
      taxAmount: line.taxAmount,
      notes: line.notes,
    })),
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
  };
}

async function getInvoiceWithLines(
  invoiceId: number,
  tx: any = db,
): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] } | null> {
  const invoices = await tx.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.id, invoiceId)).limit(1);
  const invoice = invoices[0];
  if (!invoice) return null;
  const lines = await tx.select().from(vendorInvoiceLinesTable)
    .where(eq(vendorInvoiceLinesTable.invoiceId, invoiceId))
    .orderBy(asc(vendorInvoiceLinesTable.id));
  return { invoice, lines };
}

export async function createMarketplaceVendorInvoice(
  input: CreateMarketplaceVendorInvoiceInput,
  actor: ActorInfo,
  scopedDb: typeof db = db,
): Promise<InvoiceServiceResult> {
  const invoiceRef = input.vendorInvoiceRef.trim();
  if (!invoiceRef || invoiceRef.length > 120) {
    return { ok: false, code: "INVALID_REFERENCE", message: "Nomor invoice vendor wajib diisi dan maksimal 120 karakter" };
  }
  if (!(input.invoiceDate instanceof Date) || Number.isNaN(input.invoiceDate.getTime())) {
    return { ok: false, code: "INVALID_DATE", message: "Tanggal invoice tidak valid" };
  }
  if (!input.lines.length) return { ok: false, code: "NO_LINES", message: "Invoice wajib memiliki minimal satu line" };
  const currency = normalizeCurrency(input.currency);
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, code: "INVALID_CURRENCY" };
  if (![input.totalAmount, input.taxAmount, input.grandTotal].every(Number.isFinite)) {
    return { ok: false, code: "INVALID_TOTAL" };
  }
  if (!closeEnough(money(input.totalAmount + input.taxAmount), money(input.grandTotal))) {
    return { ok: false, code: "INVALID_TOTAL", message: "grandTotal harus sama dengan totalAmount + taxAmount" };
  }

  try {
    const result = await scopedDb.transaction(async (tx) => {
      // DEV opt-in only. The existing privileged/default service keeps its
      // canonical row locks. Restricted Finance instead requests the SAME
      // database row locks through a narrowly authorized SECURITY DEFINER
      // routine; Finance itself receives no UPDATE grant on PO/GR.
      const restrictedParentLock = scopedDb !== db
        && process.env.APP_ENV?.trim().toLowerCase() === "development"
        && process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV === "true"
        && process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV === "true";
      if (restrictedParentLock) {
        // Fail closed if migration, EXECUTE permission, RLS or scoped PO/GR
        // checks are missing. Never silently substitute unlocked SELECT.
        const lock = await tx.execute(sql`
          SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
            ${input.poId}::integer, ${input.grId}::integer, ${input.supplierId}::integer,
            ${input.vendorToken ?? null}::text
          ) AS locked
        `);
        if (lock.rows[0]?.locked !== true)
          return { ok: false as const, code: "PO_NOT_FOUND" as const };
      }
      const [po] = restrictedParentLock
        ? await tx.select().from(mktPurchaseOrdersTable)
            .where(eq(mktPurchaseOrdersTable.id, input.poId)).limit(1)
        : await tx.select().from(mktPurchaseOrdersTable)
            .where(eq(mktPurchaseOrdersTable.id, input.poId)).for("update").limit(1);
      if (!po) return { ok: false as const, code: "PO_NOT_FOUND" as const };
      if (po.status === "cancelled") return { ok: false as const, code: "PO_CANCELLED" as const };
      if (po.vendorId !== input.supplierId) {
        return { ok: false as const, code: "PO_NOT_FOUND" as const };
      }
      if (!po.companyId || (input.companyId != null && input.companyId !== po.companyId)) {
        return { ok: false as const, code: "COMPANY_SCOPE_INVALID" as const };
      }

      const [gr] = restrictedParentLock
        ? await tx.select().from(mktPoGoodsReceiptsTable)
            .where(eq(mktPoGoodsReceiptsTable.id, input.grId)).limit(1)
        : await tx.select().from(mktPoGoodsReceiptsTable)
            .where(eq(mktPoGoodsReceiptsTable.id, input.grId)).for("update").limit(1);
      if (!gr) return { ok: false as const, code: "GR_NOT_FOUND" as const };
      const [shipment] = await tx.select().from(mktPoShipmentsTable)
        .where(eq(mktPoShipmentsTable.id, gr.shipmentId)).limit(1);
      if (!shipment || shipment.poId !== po.id) return { ok: false as const, code: "GR_NOT_FOR_PO" as const };
      if (shipment.shipmentStatus !== "delivered") {
        return { ok: false as const, code: "SHIPMENT_NOT_DELIVERED" as const };
      }

      const receiptItems = await tx.select().from(mktPoGoodsReceiptItemsTable)
        .where(eq(mktPoGoodsReceiptItemsTable.goodsReceiptId, gr.id));
      if (!receiptItems.length || gr.inspectionStatus !== "passed") {
        return { ok: false as const, code: "RECEIPT_NOT_ACCEPTED" as const };
      }
      const poLines = await tx.select().from(mktPurchaseOrderLinesTable)
        .where(eq(mktPurchaseOrderLinesTable.poId, po.id));
      const poLineIds = new Set(poLines.map((line) => line.id));
      const poLineMap = new Map(poLines.map((line) => [line.id, line]));
      if (input.lines.some((line) =>
        !Number.isInteger(line.poLineId) || line.poLineId <= 0 ||
        !poLineIds.has(line.poLineId) ||
        !Number.isFinite(line.quantity) || line.quantity <= 0 ||
        !Number.isFinite(line.unitPrice) || line.unitPrice < 0 ||
        !Number.isFinite(line.subtotal) || line.subtotal < 0 ||
        !closeEnough(money(line.subtotal), money(line.quantity * line.unitPrice)),
      )) {
        return { ok: false as const, code: "INVALID_LINE" as const, message: "Invoice line tidak valid atau tidak berasal dari PO" };
      }
      if (input.lines.some((line) => {
        const poLine = poLineMap.get(line.poLineId);
        return !poLine || !closeEnough(line.unitPrice, Number(poLine.unitPrice));
      })) {
        return {
          ok: false as const,
          code: "INVALID_LINE" as const,
          message: "Harga invoice harus sama dengan harga transaksi pada PO",
        };
      }

      const duplicate = await tx.select().from(vendorInvoicesTable).where(and(
        eq(vendorInvoicesTable.supplierId, input.supplierId),
        eq(vendorInvoicesTable.vendorInvoiceRef, invoiceRef),
        eq(vendorInvoicesTable.mktPurchaseOrderId, po.id),
      )).limit(1);
      if (duplicate[0]) {
        const existing = await getInvoiceWithLines(duplicate[0].id, tx);
        return {
          ok: true as const,
          invoice: existing!.invoice,
          lines: existing!.lines,
          alreadyExists: true,
        };
      }

      // The dedicated Finance role has INSERT on exactly 20 permitted Invoice
      // columns and 9 Invoice Line columns, NOT a blanket table INSERT.
      // Drizzle's generic insert builder explicitly lists every table column
      // (including those set to DEFAULT), which requires privileges outside
      // the reviewed grant list. Use one parameterized SQL writer here instead
      // of widening permissions or forking the canonical invoice service.
      const newHeader = await tx.execute(sql`
        INSERT INTO public.vendor_invoices (
          invoice_number, vendor_invoice_ref, company_id, supplier_id,
          supplier_name, mkt_purchase_order_id, mkt_goods_receipt_id,
          status, invoice_date, currency, total_amount, tax_amount,
          grand_total, three_way_match_status, notes,
          attachment_object_path, attachment_file_name,
          attachment_content_type, attachment_size, created_by
        ) VALUES (
          ${newInvoiceNumber()}, ${invoiceRef}, ${po.companyId},
          ${input.supplierId}, ${input.supplierName}, ${po.id}, ${gr.id},
          'draft', ${input.invoiceDate}, ${currency},
          ${input.totalAmount.toFixed(2)}, ${input.taxAmount.toFixed(2)},
          ${input.grandTotal.toFixed(2)}, 'unmatched',
          ${input.notes ?? null}, ${input.attachment.objectPath},
          ${input.attachment.fileName}, ${input.attachment.contentType},
          ${input.attachment.size}, ${input.createdBy ?? actor.actorId ?? null}
        ) RETURNING id
      `);
      const invoiceId = Number(newHeader.rows[0]?.id);
      if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
        throw new Error("CANONICAL_VENDOR_INVOICE_INSERT_RETURNED_NO_ID");
      }
      const [inserted] = await tx.select().from(vendorInvoicesTable)
        .where(eq(vendorInvoicesTable.id, invoiceId)).limit(1);
      if (!inserted) throw new Error("CANONICAL_VENDOR_INVOICE_INSERT_NOT_VISIBLE");

      const lines: InvoiceLineRow[] = [];
      for (const line of input.lines) {
        const newLine = await tx.execute(sql`
          INSERT INTO public.vendor_invoice_lines (
            invoice_id, mkt_purchase_order_line_id, name,
            quantity, unit, unit_cost, subtotal, tax_amount, notes
          ) VALUES (
            ${invoiceId}, ${line.poLineId},
            ${line.name ?? `PO line ${line.poLineId}`},
            ${line.quantity.toFixed(2)}, ${line.unit ?? "pcs"},
            ${line.unitPrice.toFixed(2)}, ${line.subtotal.toFixed(2)},
            ${(line.taxAmount ?? 0).toFixed(2)}, ${line.notes ?? null}
          ) RETURNING id
        `);
        const lineId = Number(newLine.rows[0]?.id);
        if (!Number.isSafeInteger(lineId) || lineId <= 0) {
          throw new Error("CANONICAL_VENDOR_INVOICE_LINE_INSERT_RETURNED_NO_ID");
        }
        const [createdLine] = await tx.select().from(vendorInvoiceLinesTable)
          .where(eq(vendorInvoiceLinesTable.id, lineId)).limit(1);
        if (!createdLine) throw new Error("CANONICAL_VENDOR_INVOICE_LINE_INSERT_NOT_VISIBLE");
        lines.push(createdLine);
      }
      return { ok: true as const, invoice: inserted, lines, alreadyExists: false };
    });

    if (result.ok && !result.alreadyExists) {
      const publish = () => {
      void logActivity({
        mktPurchaseOrderId: input.poId,
        actorType: actor.actorType,
        actorId: actor.actorId ?? null,
        actorName: actor.actorName ?? null,
        action: "invoice_uploaded",
        description: `Vendor invoice ${result.invoice.vendorInvoiceRef} diunggah`,
        newValue: { invoiceId: result.invoice.id, goodsReceiptId: input.grId, status: "draft" },
      });
      void enqueueNotification({
        eventType: "mkt_vendor_invoice_uploaded",
        recipientType: "admin",
        purchaseOrderId: input.poId,
        payloadJson: { invoiceId: result.invoice.id, poId: input.poId, grId: input.grId },
        deduplicationKey: `mkt_vendor_invoice_uploaded:${result.invoice.id}`,
      });
      };
      if (scopedDb === db) publish();
      else onMarketplaceFinanceCommit(scopedDb, publish);
    }
    return result;
  } catch (error: any) {
    if (error?.code === "23505") return { ok: false, code: "DUPLICATE_INVOICE" };
    throw error;
  }
}

interface MatchResult {
  ok: boolean;
  status: "passed" | "failed";
  reasons: Array<{ code: string; message: string; poLineId?: number }>;
}

async function evaluateThreeWayMatch(tx: any, invoice: InvoiceRow, lines: InvoiceLineRow[]): Promise<MatchResult> {
  const reasons: MatchResult["reasons"] = [];
  const poId = invoice.mktPurchaseOrderId;
  const grId = invoice.mktGoodsReceiptId;
  if (!poId || !grId) return { ok: false, status: "failed", reasons: [{ code: "MISSING_REFERENCE", message: "PO dan Goods Receipt wajib diisi" }] };

  const [po] = await tx.select().from(mktPurchaseOrdersTable).where(eq(mktPurchaseOrdersTable.id, poId)).limit(1);
  const [gr] = await tx.select().from(mktPoGoodsReceiptsTable).where(eq(mktPoGoodsReceiptsTable.id, grId)).limit(1);
  if (!po) reasons.push({ code: "PO_NOT_FOUND", message: "Marketplace PO tidak ditemukan" });
  if (!gr) reasons.push({ code: "GR_NOT_FOUND", message: "Marketplace Goods Receipt tidak ditemukan" });
  if (!po || !gr) return { ok: false, status: "failed", reasons };

  const [shipment] = await tx.select().from(mktPoShipmentsTable).where(eq(mktPoShipmentsTable.id, gr.shipmentId)).limit(1);
  if (!shipment || shipment.poId !== po.id) {
    reasons.push({ code: "GR_NOT_FOR_PO", message: "Goods Receipt tidak terkait dengan PO" });
    return { ok: false, status: "failed", reasons };
  }
  if (shipment.shipmentStatus !== "delivered") {
    reasons.push({ code: "SHIPMENT_NOT_DELIVERED", message: "Shipment belum berstatus delivered" });
  }
  if (gr.inspectionStatus !== "passed") {
    reasons.push({ code: "RECEIPT_NOT_ACCEPTED", message: "Goods Receipt belum lolos inspection" });
  }

  const poLines = await tx.select().from(mktPurchaseOrderLinesTable).where(eq(mktPurchaseOrderLinesTable.poId, po.id));
  const shipmentItems = await tx.select().from(mktPoShipmentItemsTable).where(eq(mktPoShipmentItemsTable.shipmentId, shipment.id));
  const receiptItems = await tx.select().from(mktPoGoodsReceiptItemsTable).where(eq(mktPoGoodsReceiptItemsTable.goodsReceiptId, gr.id));
  const shipmentToPo = new Map<number, number>(
    shipmentItems.map((item: typeof mktPoShipmentItemsTable.$inferSelect) => [item.id, item.poLineId]),
  );
  const acceptedByPoLine = new Map<number, number>();
  for (const item of receiptItems) {
    const poLineId = shipmentToPo.get(item.shipmentItemId);
    if (poLineId) acceptedByPoLine.set(poLineId, (acceptedByPoLine.get(poLineId) ?? 0) + Number(item.acceptedQty));
  }
  const poLineMap = new Map<number, typeof mktPurchaseOrderLinesTable.$inferSelect>(
    poLines.map((line: typeof mktPurchaseOrderLinesTable.$inferSelect) => [line.id, line]),
  );
  const seen = new Set<number>();
  let computedTotal = 0;
  let computedTax = 0;
  for (const line of lines) {
    const poLineId = line.mktPurchaseOrderLineId;
    const poLine = poLineId ? poLineMap.get(poLineId) : undefined;
    if (!poLine || seen.has(poLineId!)) {
      reasons.push({ code: "INVALID_LINE", message: "Invoice line tidak cocok dengan PO line", poLineId: poLineId ?? undefined });
      continue;
    }
    seen.add(poLineId!);
    const qty = Number(line.quantity);
    const unitPrice = Number(line.unitCost);
    const subtotal = Number(line.subtotal);
    const acceptedQty = acceptedByPoLine.get(poLineId!) ?? 0;
    if (qty <= 0 || qty - acceptedQty > QTY_TOLERANCE || acceptedQty - qty > QTY_TOLERANCE) {
      reasons.push({ code: "QUANTITY_MISMATCH", message: "Quantity invoice melebihi quantity diterima", poLineId: poLineId! });
    }
    if (!closeEnough(unitPrice, Number(poLine.unitPrice))) {
      reasons.push({ code: "PRICE_MISMATCH", message: "Unit price invoice berbeda dari PO", poLineId: poLineId! });
    }
    if (!closeEnough(subtotal, money(qty * unitPrice))) {
      reasons.push({ code: "SUBTOTAL_MISMATCH", message: "Subtotal invoice tidak konsisten", poLineId: poLineId! });
    }
    computedTotal += subtotal;
    computedTax += Number(line.taxAmount ?? 0);
  }
  for (const [poLineId, acceptedQty] of acceptedByPoLine) {
    if (acceptedQty > QTY_TOLERANCE && !seen.has(poLineId)) {
      reasons.push({ code: "MISSING_LINE", message: "Invoice tidak memuat line yang diterima", poLineId });
    }
  }
  if (!closeEnough(computedTotal, Number(invoice.totalAmount))) reasons.push({ code: "AMOUNT_MISMATCH", message: "Total invoice berbeda dari jumlah line" });
  if (!closeEnough(computedTax, Number(invoice.taxAmount))) reasons.push({ code: "TAX_MISMATCH", message: "Tax invoice berbeda dari jumlah line" });
  if (!closeEnough(computedTotal + computedTax, Number(invoice.grandTotal))) reasons.push({ code: "GRAND_TOTAL_MISMATCH", message: "Grand total invoice tidak konsisten" });
  const poCurrency = normalizeCurrency(po.currencySnapshot ?? "IDR");
  if (normalizeCurrency(invoice.currency) !== poCurrency) reasons.push({ code: "CURRENCY_MISMATCH", message: "Currency invoice berbeda dari PO" });
  return { ok: reasons.length === 0, status: reasons.length === 0 ? "passed" : "failed", reasons };
}

export async function submitMarketplaceVendorInvoice(
  invoiceId: number,
  actor: ActorInfo,
  scopedDb: typeof db = db,
): Promise<InvoiceServiceResult & { match?: MatchResult }> {
  const result = await scopedDb.transaction(async (tx) => {
    const [invoice] = await tx.select().from(vendorInvoicesTable)
      .where(eq(vendorInvoicesTable.id, invoiceId)).for("update").limit(1);
    if (!invoice) return { ok: false as const, code: "PO_NOT_FOUND" as const, message: "Invoice tidak ditemukan" };
    if (!invoice.mktPurchaseOrderId || !invoice.mktGoodsReceiptId) {
      return { ok: false as const, code: "GR_NOT_FOUND" as const, message: "Invoice wajib memiliki PO dan Goods Receipt" };
    }
    const [poScope] = await tx.select().from(mktPurchaseOrdersTable)
      .where(eq(mktPurchaseOrdersTable.id, invoice.mktPurchaseOrderId)).limit(1);
    if (!poScope?.companyId || !invoice.companyId ||
        poScope.companyId !== invoice.companyId ||
        poScope.vendorId !== invoice.supplierId) {
      return { ok: false as const, code: "COMPANY_SCOPE_INVALID" as const };
    }
    if (invoice.status === "ready_for_ap") {
      const existing = await getInvoiceWithLines(invoice.id, tx);
      return { ok: true as const, invoice: existing!.invoice, lines: existing!.lines, alreadyExists: true, match: { ok: true, status: "passed" as const, reasons: [] } };
    }
    if (!["draft", "submitted"].includes(invoice.status)) {
      return { ok: false as const, code: "INVALID_STATUS" as const, message: `Invoice tidak dapat disubmit dari status ${invoice.status}` };
    }
    const lines = await tx.select().from(vendorInvoiceLinesTable).where(eq(vendorInvoiceLinesTable.invoiceId, invoice.id)).orderBy(asc(vendorInvoiceLinesTable.id));
    await tx.update(vendorInvoicesTable).set({ status: "submitted", updatedAt: new Date() }).where(and(
      eq(vendorInvoicesTable.id, invoice.id),
      inArray(vendorInvoicesTable.status, ["draft", "submitted"]),
    ));
    const match = await evaluateThreeWayMatch(tx, { ...invoice, status: "submitted" }, lines);
    const nextStatus = match.ok ? "ready_for_ap" : "submitted";
    const [updated] = await tx.update(vendorInvoicesTable).set({
      status: nextStatus,
      threeWayMatchStatus: match.status,
      matchNotes: match.reasons.length ? JSON.stringify(match.reasons) : null,
      updatedAt: new Date(),
    }).where(eq(vendorInvoicesTable.id, invoice.id)).returning();
    return { ok: true as const, invoice: updated, lines, alreadyExists: false, match };
  });

  if (result.ok && !result.alreadyExists) {
    const publish = () => {
    const action = result.match?.ok ? "invoice_ready_for_ap" : "invoice_submitted";
    void logActivity({
      mktPurchaseOrderId: result.invoice.mktPurchaseOrderId,
      actorType: actor.actorType,
      actorId: actor.actorId ?? null,
      actorName: actor.actorName ?? null,
      action,
      description: `Vendor invoice ${result.invoice.vendorInvoiceRef} berstatus ${result.invoice.status}`,
      newValue: { invoiceId: result.invoice.id, status: result.invoice.status, matchStatus: result.invoice.threeWayMatchStatus },
    });
    void logActivity({
      mktPurchaseOrderId: result.invoice.mktPurchaseOrderId,
      actorType: "system",
      action: result.match?.ok ? "three_way_match_passed" : "three_way_match_failed",
      description: result.match?.ok
        ? `3-Way Match invoice ${result.invoice.vendorInvoiceRef} berhasil`
        : `3-Way Match invoice ${result.invoice.vendorInvoiceRef} gagal`,
      newValue: {
        invoiceId: result.invoice.id,
        status: result.match?.status,
        reasons: result.match?.reasons ?? [],
      },
    });
    void enqueueNotification({
      eventType: result.match?.ok ? "mkt_vendor_invoice_ready_for_ap" : "mkt_vendor_invoice_submitted",
      recipientType: "admin",
      purchaseOrderId: result.invoice.mktPurchaseOrderId,
      payloadJson: { invoiceId: result.invoice.id, status: result.invoice.status },
      deduplicationKey: `mkt_vendor_invoice:${result.invoice.id}:${result.invoice.status}`,
    });
    };
    if (scopedDb === db) publish();
    else onMarketplaceFinanceCommit(scopedDb, publish);
  }
  return result;
}

export async function getMarketplaceVendorInvoice(invoiceId: number, scopedDb: typeof db = db) {
  return getInvoiceWithLines(invoiceId, scopedDb);
}