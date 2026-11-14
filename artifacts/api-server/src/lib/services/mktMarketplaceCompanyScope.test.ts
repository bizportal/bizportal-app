import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  rows: new Map<string, unknown[]>(),
  writes: vi.fn(),
  reads: [] as string[],
}));
vi.mock("@workspace/db", () => {
  const keys = [
    "mktPurchaseOrdersTable", "mktPoGoodsReceiptsTable",
    "mktPoShipmentItemsTable", "mktPoShipmentsTable",
    "mktPurchaseOrderLinesTable", "vendorInvoiceLinesTable",
    "vendorInvoicesTable", "mktPoGoodsReceiptItemsTable",
    "mktApPreparationsTable",
  ];
  const tables = Object.fromEntries(keys.map(k => [k, { key: k }]));
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: () => ({
          from: (table: { key: string }) => {
            const get = async () => {
              mock.reads.push(table.key);
              return mock.rows.get(table.key) ?? [];
            };
            return {
              where: () => ({ for: () => ({ limit: get }), limit: get }),
            };
          },
        }),
        insert: mock.writes,
        update: mock.writes,
      };
      return callback(tx);
    }),
  };
  return { db, ...tables };
});
vi.mock("drizzle-orm", () => ({
  and: vi.fn(), eq: vi.fn(), asc: vi.fn(), inArray: vi.fn(),
}));
vi.mock("../activityLog.js", () => ({ logActivity: vi.fn() }));
vi.mock("./marketplaceNotificationQueueService.js", () => ({ enqueueNotification: vi.fn() }));

import { createMarketplaceVendorInvoice, submitMarketplaceVendorInvoice } from "./mktVendorInvoiceService.js";
import { createApPreparation } from "./mktApPreparationService.js";

const input = {
  poId: 12, grId: 9, vendorInvoiceRef: "DEV-NO-WRITE-TEST",
  invoiceDate: new Date("2026-11-14"), currency: "IDR",
  totalAmount: 100, taxAmount: 0, grandTotal: 100,
  supplierId: 5, supplierName: "DEV Supplier", companyId: 7,
  attachment: { objectPath: "dev-only/no-write.pdf", fileName: "test.pdf", contentType: "application/pdf", size: 20 },
  lines: [{ poLineId: 6, quantity: 1, unitPrice: 100, subtotal: 100 }],
};
const actor = { actorType: "admin" as const, actorId: "dev-test" };
beforeEach(() => {
  mock.rows.clear();
  mock.writes.mockReset();
  mock.reads.length = 0;
});
describe("canonical finance service rejects invalid company scope before any write", () => {
  it("rejects a historical null-company PO even if the caller provides a company", async () => {
    mock.rows.set("mktPurchaseOrdersTable", [{ id: 12, vendorId: 5, companyId: null, status: "completed" }]);
    const result = await createMarketplaceVendorInvoice(input, actor);
    expect(result).toMatchObject({ ok: false, code: "COMPANY_SCOPE_INVALID" });
    expect(mock.reads).toEqual(["mktPurchaseOrdersTable"]);
    expect(mock.writes).not.toHaveBeenCalled();
  });
  it("rejects company substitution even on an otherwise valid PO", async () => {
    mock.rows.set("mktPurchaseOrdersTable", [{ id: 12, vendorId: 5, companyId: 2, status: "completed" }]);
    const result = await createMarketplaceVendorInvoice(input, actor);
    expect(result).toMatchObject({ ok: false, code: "COMPANY_SCOPE_INVALID" });
    expect(mock.writes).not.toHaveBeenCalled();
  });
  it("does not submit a null-company invoice to 3-way match", async () => {
    mock.rows.set("vendorInvoicesTable", [{
      id: 77, status: "draft", companyId: null, supplierId: 5,
      mktPurchaseOrderId: 12, mktGoodsReceiptId: 9,
    }]);
    mock.rows.set("mktPurchaseOrdersTable", [{ id: 12, companyId: null, vendorId: 5 }]);
    const result = await submitMarketplaceVendorInvoice(77, actor);
    expect(result).toMatchObject({ ok: false, code: "COMPANY_SCOPE_INVALID" });
    expect(mock.writes).not.toHaveBeenCalled();
  });
  it("does not create AP from invoice/PO with null company", async () => {
    mock.rows.set("vendorInvoicesTable", [{
      id: 77, status: "ready_for_ap", threeWayMatchStatus: "passed",
      companyId: null, supplierId: 5, mktPurchaseOrderId: 12, mktGoodsReceiptId: 9,
    }]);
    mock.rows.set("mktApPreparationsTable", []);
    mock.rows.set("mktPurchaseOrdersTable", [{ id: 12, companyId: null, vendorId: 5 }]);
    mock.rows.set("mktPoGoodsReceiptsTable", [{ id: 9, shipmentId: 3 }]);
    const result = await createApPreparation(77, { actorId: "dev-test" });
    expect(result).toMatchObject({ ok: false, code: "MISSING_REFERENCE" });
    expect(mock.writes).not.toHaveBeenCalled();
  });
});
