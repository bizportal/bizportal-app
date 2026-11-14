import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  dev: vi.fn(() => true),
  legacy: vi.fn(),
  signed: vi.fn(),
  verified: vi.fn(),
  imported: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: mocks.dev,
  getDevSession: mocks.legacy,
  getProductionSession: mocks.signed,
  getProductionUser: mocks.verified,
}));
vi.mock("../lib/gmail-invoice-candidates", () => ({
  importGmailInvoiceCandidate: mocks.imported,
  listGmailInvoiceCandidates: vi.fn(),
  syncGmailInvoiceCandidates: vi.fn(),
  reviewGmailInvoiceCandidate: vi.fn(),
}));
vi.mock("../lib/gmail-invoice-runtime", () => ({ getRuntimeConfig: vi.fn() }));
vi.mock("../lib/gmail-organization", () => ({
  listGmailOrganizationRules: vi.fn(),
  provisionGmailOrganizationRules: vi.fn(),
}));

import router from "./gmail-invoice-source";

describe("Gmail import HTTP security contract using simulated verified signed-session identity", () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "log", {
        value: { error: () => undefined, warn: () => undefined },
        configurable: true,
      });
      next();
    });
    app.use("/api", router);
    server = await new Promise<http.Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dev.mockReturnValue(true);
    mocks.legacy.mockReturnValue(null);
    mocks.signed.mockReturnValue({ kind: "simulated-signed-otp" });
    mocks.verified.mockResolvedValue({
      role: "super_admin", email: "scoped@example.invalid", companyId: 1,
    });
    mocks.imported.mockResolvedValue({
      vendorInvoiceId: 501, invoiceNumber: "VI/2026/00501", existing: false, status: "draft",
    });
  });

  async function post(companyId: unknown, id = "4") {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Missing test server");
    const payload = JSON.stringify({ company_id: companyId });
    return new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1", port: addr.port,
        path: "/api/recon-classification/invoice-sources/gmail/candidates/" + id + "/import",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      }, (res) => {
        let raw = "";
        res.on("data", (chunk) => raw += chunk.toString());
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          data: raw ? JSON.parse(raw) as Record<string, unknown> : {},
        }));
      });
      request.on("error", reject);
      request.end(payload);
    });
  }

  it("rejects an anonymous caller before financial import", async () => {
    mocks.signed.mockReturnValue(null);
    expect((await post(1)).status).toBe(401);
    expect(mocks.imported).not.toHaveBeenCalled();
  });

  it.each(["admin", "owner", "super_admin"] as const)(
    "denies unscoped %s even with a caller-provided company_id",
    async (role) => {
      mocks.verified.mockResolvedValue({ role, email: "unscoped@example.invalid", companyId: null });
      const result = await post(1);
      expect(result.status).toBe(403);
      expect(result.data.code).toBe("COMPANY_SCOPE_MISSING");
      expect(mocks.imported).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );

  it("denies a different company before the canonical import writer", async () => {
    mocks.verified.mockResolvedValue({ role: "admin", email: "bound@example.invalid", companyId: 2 });
    const result = await post(1);
    expect(result.status).toBe(403);
    expect(result.data.code).toBe("COMPANY_SCOPE_FORBIDDEN");
    expect(mocks.imported).not.toHaveBeenCalled();
  });

  it("requires a valid candidate ID and rejects non-admin roles", async () => {
    expect((await post(1, "wrong")).status).toBe(400);
    mocks.verified.mockResolvedValue({ role: "finance", email: "finance@example.invalid", companyId: 1 });
    expect((await post(1)).status).toBe(401);
    expect(mocks.imported).not.toHaveBeenCalled();
  });

  it("passes a verified same-company Super Admin into the existing writer", async () => {
    const result = await post(1);
    expect(result.status).toBe(201);
    expect(mocks.imported).toHaveBeenCalledOnce();
    expect(mocks.imported).toHaveBeenCalledWith({
      companyId: 1, candidateId: 4, actorEmail: "scoped@example.invalid",
    });
  });

  it("forwards the financial fail-closed 409 code for a historical Payment slip", async () => {
    mocks.imported.mockRejectedValue(Object.assign(
      new Error("Payment slip is not a payable vendor invoice"), {
        status: 409, code: "GMAIL_PAYMENT_EVIDENCE_NOT_PAYABLE",
      },
    ));
    const result = await post(1);
    expect(result.status).toBe(409);
    expect(result.data.code).toBe("GMAIL_PAYMENT_EVIDENCE_NOT_PAYABLE");
    expect(mocks.imported).toHaveBeenCalledOnce();
  });
});
