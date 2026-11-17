import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contract test for the ORIGINAL canonical Invoice service's PR108 bridge.
// SQL / roles are separately exercised with real PostgreSQL in PR108's
// disposable CI; these tests assert the application never bypasses that
// function or writes on a missing/denied lock. No real DB or credentials.
const probe = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  postCommit: vi.fn(),
  activity: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const names = [
    "mktPurchaseOrdersTable", "mktPurchaseOrderLinesTable",
    "mktPoShipmentsTable", "mktPoShipmentItemsTable",
    "mktPoGoodsReceiptsTable", "mktPoGoodsReceiptItemsTable",
    "vendorInvoicesTable", "vendorInvoiceLinesTable",
  ];
  const tables = Object.fromEntries(names.map((name) => [name, { name }]));
  return {
    db: { transaction: vi.fn() },
    onMarketplaceFinanceCommit: probe.postCommit,
    ...tables,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), and: vi.fn(), asc: vi.fn(), inArray: vi.fn(),
  sql: (strings: TemplateStringsArray, ...params: unknown[]) => ({
    text: strings.join("?"),
    params,
  }),
}));
vi.mock("../activityLog.js", () => ({ logActivity: probe.activity }));
vi.mock("./marketplaceNotificationQueueService.js", () => ({
  enqueueNotification: probe.notify,
}));

import { createMarketplaceVendorInvoice } from "./mktVendorInvoiceService.js";

const input = {
  poId: 14,
  grId: 6,
  vendorToken: "a".repeat(64),
  vendorInvoiceRef: "DEV-LOCK-CONTRACT-ONLY",
  invoiceDate: new Date("2026-11-17T00:00:00Z"),
  currency: "IDR",
  totalAmount: 100000,
  taxAmount: 0,
  grandTotal: 100000,
  supplierId: 24,
  supplierName: "Synthetic Test Vendor",
  companyId: 1,
  lines: [{ poLineId: 1, quantity: 1, unitPrice: 100000, subtotal: 100000 }],
  attachment: {
    objectPath: "synthetic-only/never-uploaded.pdf",
    fileName: "TEST.pdf", contentType: "application/pdf", size: 20,
  },
};
const actor = { actorType: "vendor" as const, actorId: "synthetic" };
const saved = {
  app: process.env.APP_ENV,
  writer: process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV,
  lock: process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV,
};

function isolatedTx() {
  const tx = { execute: probe.execute, select: probe.select, insert: probe.insert };
  return { transaction: vi.fn(async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ENV = "development";
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "true";
  process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV = "true";
  // Default SELECT is empty: even a successful lock does not invent a PO.
  probe.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [],
        for: () => ({ limit: async () => [] }),
      }),
    }),
  }));
});
afterEach(() => {
  for (const [key, original] of [
    ["APP_ENV", saved.app],
    ["BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV", saved.writer],
    ["BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV", saved.lock],
  ] as const) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("canonical vendor invoice -> PR108 private parent lock (DEV only)", () => {
  it("denied lock stops before ALL parent SELECTs, INSERTs and callbacks", async () => {
    probe.execute.mockResolvedValueOnce({ rows: [{ locked: false }] });
    const scoped = isolatedTx();
    const result = await createMarketplaceVendorInvoice(input, actor, scoped as never);
    expect(result).toMatchObject({ ok: false, code: "PO_NOT_FOUND" });
    expect(probe.execute).toHaveBeenCalledTimes(1);
    expect(probe.execute.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining("finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev"),
      params: [14, 6, 24, "a".repeat(64)],
    });
    expect(probe.select).not.toHaveBeenCalled();
    expect(probe.insert).not.toHaveBeenCalled();
    expect(probe.postCommit).not.toHaveBeenCalled();
    expect(probe.activity).not.toHaveBeenCalled();
    expect(probe.notify).not.toHaveBeenCalled();
  });

  it("missing private function fails closed (no unlocked fallback)", async () => {
    probe.execute.mockRejectedValueOnce(Object.assign(new Error("undefined function"), {
      code: "42883",
    }));
    const scoped = isolatedTx();
    await expect(createMarketplaceVendorInvoice(input, actor, scoped as never))
      .rejects.toMatchObject({ code: "42883" });
    expect(probe.execute).toHaveBeenCalledTimes(1);
    expect(probe.select).not.toHaveBeenCalled();
    expect(probe.insert).not.toHaveBeenCalled();
  });

  it("successful lock permits canonical PO lookup but cannot invent a missing PO", async () => {
    probe.execute.mockResolvedValueOnce({ rows: [{ locked: true }] });
    const result = await createMarketplaceVendorInvoice(input, actor, isolatedTx() as never);
    expect(result).toMatchObject({ ok: false, code: "PO_NOT_FOUND" });
    expect(probe.execute).toHaveBeenCalledTimes(1);
    expect(probe.select).toHaveBeenCalledTimes(1);
    expect(probe.insert).not.toHaveBeenCalled();
  });

  it("legacy flag OFF does not invoke the new function", async () => {
    process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV = "false";
    const result = await createMarketplaceVendorInvoice(input, actor, isolatedTx() as never);
    expect(result).toMatchObject({ ok: false, code: "PO_NOT_FOUND" });
    expect(probe.execute).not.toHaveBeenCalled();
    expect(probe.select).toHaveBeenCalledTimes(1);
    expect(probe.insert).not.toHaveBeenCalled();
  });
});