import http from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  dev: vi.fn(),
  legacy: vi.fn(),
  signed: vi.fn(),
  verified: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: mocks.dev,
  getDevSession: mocks.legacy,
  getProductionSession: mocks.signed,
  getProductionUser: mocks.verified,
}));
vi.mock("../lib/gmail-invoice-candidates", () => ({
  importGmailInvoiceCandidate: vi.fn(),
  listGmailInvoiceCandidates: vi.fn(),
  syncGmailInvoiceCandidates: vi.fn(),
}));
vi.mock("../lib/gmail-invoice-runtime", () => ({ getRuntimeConfig: vi.fn() }));
vi.mock("../lib/gmail-organization", () => ({
  listGmailOrganizationRules: vi.fn(),
  provisionGmailOrganizationRules: vi.fn(),
}));

import router from "./gmail-invoice-source";

const FLAG = "BIZPORTAL_GMAIL_MATCH_PROPOSALS_ENABLED_DEV";
const previous = process.env[FLAG];

describe("DEV Gmail Match INV proposals preserve source read-only contract", () => {
  let server: http.Server;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "log", {value: {error: () => undefined}, configurable: true});
      next();
    });
    app.use("/api", router);
    server = await new Promise<http.Server>(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "test";
    delete process.env[FLAG];
    mocks.dev.mockReturnValue(true);
    mocks.legacy.mockReturnValue(null);
    mocks.signed.mockReturnValue(null);
    mocks.verified.mockResolvedValue(null);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from public.bank_mutations")) return {
        rows: [{amount: "100000", description: "vendor invoice"}],
      };
      if (sql.includes("from public.gmail_invoice_candidates s")) return {
        rows: [{
          id: 12,
          extracted_vendor_name: "Vendor Example",
          extracted_invoice_number: "INV-2026-001",
          extracted_total: "100000",
          attachment_file_name: "Per Posting NOV26 Invoice.pdf",
          source_email: "vendor@example.com",
          extracted_json: {line_items: []},
        }],
      };
      throw new Error("Unexpected SQL in provisional preview");
    });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  });

  async function get(query = "company_id=1&mutation_id=7"): Promise<{status: number; body: Record<string, unknown>}> {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Missing local port");
    return await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: "127.0.0.1", port: addr.port,
        path: "/api/recon-classification/invoice-sources/gmail/match-proposals?" + query,
      }, res => {
        let body = "";
        res.on("data", part => {body += part.toString();});
        res.on("end", () => resolve({status: res.statusCode ?? 0, body: JSON.parse(body) as Record<string, unknown>}));
      });
      req.on("error", reject);
    });
  }

  it("is unavailable by default, before identity or DB lookup", async () => {
    const result = await get();
    expect(result.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("rejects anonymous requests and never reads candidate data", async () => {
    process.env[FLAG] = "true";
    expect((await get()).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects an unscoped admin and cross-company access before DB query", async () => {
    process.env[FLAG] = "true";
    mocks.legacy.mockReturnValue({email: "admin@example.com", role: "admin", companyId: null});
    const missingScope = await get("company_id=2&mutation_id=7");
    expect(missingScope.status).toBe(403);
    expect(missingScope.body.code).toBe("COMPANY_SCOPE_MISSING");
    expect(mocks.query).not.toHaveBeenCalled();
    mocks.legacy.mockReturnValue({email: "admin@example.com", role: "admin", companyId: 1});
    const mismatch = await get("company_id=2&mutation_id=7");
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.code).toBe("COMPANY_SCOPE_FORBIDDEN");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("provides a non-approvable preview without any INSERT/UPDATE/payment", async () => {
    process.env[FLAG] = "true";
    mocks.legacy.mockReturnValue({email: "admin@example.com", role: "admin", companyId: 1});
    const result = await get();
    expect(result.status).toBe(200);
    expect(result.body.provisional).toBe(true);
    expect(result.body.approvable).toBe(false);
    expect(result.body.mutationId).toBe(7);
    const candidates = result.body.candidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceCandidateId).toBe(12);
    expect(candidates[0].matchBasis).toBe("gross");
    const queries = mocks.query.mock.calls.map(([sql]) => String(sql));
    expect(queries).toHaveLength(2);
    expect(queries.every(sql => /^\s*select\b/i.test(sql))).toBe(true);
  });

  it("accepts a DB-verified signed OTP actor only through the existing bridge", async () => {
    process.env[FLAG] = "true";
    mocks.signed.mockReturnValue({email: "admin@example.com"});
    mocks.verified.mockResolvedValue({email: "admin@example.com", role: "owner", companyId: 1});
    expect((await get()).status).toBe(200);
    expect(mocks.verified).toHaveBeenCalledOnce();
  });

  it("blocks PROD even if a DEV flag is accidentally set", async () => {
    process.env[FLAG] = "true";
    mocks.dev.mockReturnValue(false);
    expect((await get()).status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
