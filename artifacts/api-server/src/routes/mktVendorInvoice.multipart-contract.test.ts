import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Contract HTTP test: real multer multipart parsing, Zod validation and
// PDF magic-byte checks. No external storage or business database access.
const m = vi.hoisted(() => ({
  token: vi.fn(), finance: vi.fn(), create: vi.fn(),
  upload: vi.fn(), remove: vi.fn(),
}));
vi.mock("../lib/services/mktVendorPoTokenService.js", () => ({
  findPoByVendorToken: m.token,
}));
vi.mock("@workspace/db", () => ({
  db: {},
  withMarketplaceFinanceDevTransaction: m.finance,
  vendorInvoicesTable: { id: "id", mktPurchaseOrderId: "po", supplierId: "supplier" },
}));
vi.mock("../lib/objectStorage.js", () => ({
  ObjectStorageService: class {
    uploadPrivateEntity = m.upload;
    tryDeletePrivateEntity = m.remove;
  },
}));
vi.mock("../lib/services/mktVendorInvoiceService.js", () => ({
  createMarketplaceVendorInvoice: m.create,
  getMarketplaceVendorInvoice: vi.fn(),
  submitMarketplaceVendorInvoice: vi.fn(),
  safeMarketplaceVendorInvoiceView: (invoice: any, lines: unknown[]) => ({
    id: invoice.id,
    status: invoice.status,
    companyId: invoice.companyId,
    mktPurchaseOrderId: invoice.mktPurchaseOrderId,
    lines,
  }),
}));
vi.mock("../middlewares/securityRateLimiter.js", () => ({
  tokenGetRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  tokenPostRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

import router from "./mktVendorInvoice";
const token = "a".repeat(64);
const po = { id: 12, companyId: 1, vendorId: 9, vendorNameSnapshot: "CI Vendor" };
const invoice = { id: 77, companyId: 1, supplierId: 9, mktPurchaseOrderId: 12, status: "draft" };
const scoped = { label: "CI-only restricted Finance session" };
let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/mkt/vendor-invoice", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  for (const fn of [m.token, m.finance, m.create, m.upload, m.remove]) fn.mockReset();
  m.token.mockResolvedValue({ ok: true, po });
  m.finance.mockImplementation(async (companyId: number, work: (session: unknown) => Promise<unknown>) => {
    expect(companyId).toBe(1);
    return work(scoped);
  });
  m.create.mockResolvedValue({ ok: true, invoice, lines: [], alreadyExists: false });
  m.upload.mockResolvedValue("/objects/uploads/ci-pdf-1.pdf");
  m.remove.mockResolvedValue(undefined);
});

function makeForm(options: { pdfValid?: boolean; includeFile?: boolean; companyOverride?: boolean } = {}) {
  const form = new FormData();
  form.set("grId", "19");
  form.set("vendorInvoiceRef", "CI-INV-TEST");
  form.set("invoiceDate", "2026-11-16");
  form.set("currency", "IDR");
  form.set("totalAmount", "100");
  form.set("taxAmount", "0");
  form.set("grandTotal", "100");
  form.set("lines", JSON.stringify([{
    poLineId: 13, quantity: 1, unitPrice: 100,
    subtotal: 100, taxAmount: 0, name: "CI product",
  }]));
  if (options.companyOverride) form.set("companyId", "3");
  if (options.includeFile !== false) {
    const payload = options.pdfValid === false
      ? "This is not a PDF even if the MIME says PDF."
      : "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF";
    form.set("file", new Blob([payload], { type: "application/pdf" }), "ci-vendor-invoice.pdf");
  }
  return form;
}
const upload = (form: FormData) => fetch(base + "/api/mkt/vendor-invoice/" + token, {
  method: "POST", body: form,
});

describe("canonical vendor-token multipart PDF HTTP boundary (no external writes)", () => {
  it("parses a real multipart PDF and forwards authoritative PO scope to canonical create", async () => {
    const res = await upload(makeForm());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, alreadyExists: false, data: { id: 77 } });
    expect(m.token).toHaveBeenCalledTimes(3);
    expect(m.finance).toHaveBeenCalledTimes(2);
    expect(m.upload).toHaveBeenCalledOnce();
    expect(m.upload.mock.calls[0][0]).toBeInstanceOf(Buffer);
    expect(m.upload.mock.calls[0][1]).toBe("application/pdf");
    expect(m.create).toHaveBeenCalledOnce();
    const [input, actor, session] = m.create.mock.calls[0];
    expect(input).toMatchObject({
      poId: 12, grId: 19, companyId: 1, supplierId: 9,
      supplierName: "CI Vendor", vendorInvoiceRef: "CI-INV-TEST",
      totalAmount: 100, taxAmount: 0, grandTotal: 100,
      lines: [{ poLineId: 13, quantity: 1, unitPrice: 100, subtotal: 100 }],
      attachment: { objectPath: "/objects/uploads/ci-pdf-1.pdf", contentType: "application/pdf" },
    });
    expect(actor.actorType).toBe("vendor");
    expect(session).toBe(scoped);
    expect(m.remove).not.toHaveBeenCalled();
  });

  it("rejects false PDF magic bytes before any storage call", async () => {
    const res = await upload(makeForm({ pdfValid: false }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_FILE" });
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("rejects an expired token before storage", async () => {
    m.token.mockResolvedValue({ ok: false, code: "EXPIRED" });
    const res = await upload(makeForm());
    expect(res.status).toBe(410);
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("requires a real PDF attachment after parsing valid invoice fields", async () => {
    const res = await upload(makeForm({ includeFile: false }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVOICE_FILE_REQUIRED" });
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("rejects client-supplied company overrides", async () => {
    const res = await upload(makeForm({ companyOverride: true }));
    expect(res.status).toBe(422);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("reuses canonical invoice on duplicate and deletes second temporary upload", async () => {
    m.create.mockResolvedValueOnce({ ok: true, invoice, lines: [], alreadyExists: false })
      .mockResolvedValueOnce({ ok: true, invoice, lines: [], alreadyExists: true });
    m.upload.mockResolvedValueOnce("/objects/uploads/ci-pdf-1.pdf")
      .mockResolvedValueOnce("/objects/uploads/ci-pdf-2.pdf");
    const first = await upload(makeForm());
    const repeated = await upload(makeForm());
    expect(first.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ ok: true, alreadyExists: true, data: { id: 77 } });
    expect(m.create).toHaveBeenCalledTimes(2);
    expect(m.remove).toHaveBeenCalledOnce();
    expect(m.remove).toHaveBeenCalledWith("/objects/uploads/ci-pdf-2.pdf");
  });

  it("cleans temporary upload if vendor token rotates before canonical insert", async () => {
    m.token.mockResolvedValueOnce({ ok: true, po })
      .mockResolvedValueOnce({ ok: true, po })
      .mockResolvedValueOnce({ ok: false, code: "NOT_FOUND" });
    const res = await upload(makeForm());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "TOKEN_INVALID" });
    expect(m.upload).toHaveBeenCalledOnce();
    expect(m.remove).toHaveBeenCalledWith("/objects/uploads/ci-pdf-1.pdf");
    expect(m.create).not.toHaveBeenCalled();
  });
});
