import http from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  dev: vi.fn(() => true),
  legacy: vi.fn(),
  signed: vi.fn(),
  verified: vi.fn(),
  review: vi.fn(),
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
  reviewGmailInvoiceCandidate: mocks.review,
}));
vi.mock("../lib/gmail-invoice-runtime", () => ({ getRuntimeConfig: vi.fn() }));
vi.mock("../lib/gmail-organization", () => ({
  listGmailOrganizationRules: vi.fn(),
  provisionGmailOrganizationRules: vi.fn(),
}));

import router from "./gmail-invoice-source";

const flag = "BIZPORTAL_GMAIL_REVIEW_ENABLED_DEV";
const previous = process.env[flag];

describe("DEV Gmail candidate review: no live writes and strict company binding", () => {
  let server: http.Server;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "log", { value: {error: () => undefined}, configurable: true });
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
    vi.clearAllMocks();
    mocks.dev.mockReturnValue(true);
    mocks.legacy.mockReturnValue(null);
    mocks.signed.mockReturnValue(null);
    mocks.verified.mockResolvedValue(null);
    delete process.env[flag];
    mocks.review.mockResolvedValue({ id: 41, status: "rejected" });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  });

  async function post(body: Record<string, unknown>, id = "41") {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Missing test server port");
    const payload = JSON.stringify(body);
    return new Promise<{status:number; data:Record<string,unknown>}>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: addr.port,
        path: "/api/recon-classification/invoice-sources/gmail/candidates/" + id + "/review",
        method: "POST",
        headers: {"content-type":"application/json","content-length":Buffer.byteLength(payload)},
      }, res => {
        let data = "";
        res.on("data", chunk => data += chunk.toString());
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          data: data ? JSON.parse(data) as Record<string,unknown> : {},
        }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
  const body = {company_id:1,decision:"reject",reason:"Verified invoice review reason"};

  it("is 404 and does not resolve identity or review when flag is absent", async () => {
    const result = await post(body);
    expect(result.status).toBe(404);
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("blocks anonymous callers before review", async () => {
    process.env[flag] = "true";
    expect((await post(body)).status).toBe(401);
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it.each(["admin","owner","super_admin","finance"] as const)(
    "blocks unscoped role %s even with caller-provided company",
    async role => {
      process.env[flag] = "true";
      mocks.legacy.mockReturnValue({email:"review@example.com",role,companyId:null});
      // finance is rejected upstream by existing Gmail finance-admin role check.
      expect((await post(body)).status).toBe(role==="finance" ? 401 : 403);
      expect(mocks.review).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );

  it("blocks a role bound to another company", async () => {
    process.env[flag] = "true";
    mocks.legacy.mockReturnValue({email:"review@example.com",role:"admin",companyId:2});
    const result = await post(body);
    expect(result.status).toBe(403);
    expect(result.data.code).toBe("COMPANY_SCOPE_FORBIDDEN");
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("blocks missing company, invalid candidate ID, and invalid decision", async () => {
    process.env[flag] = "true";
    mocks.legacy.mockReturnValue({email:"review@example.com",role:"admin",companyId:1});
    expect((await post({...body,company_id:null})).status).toBe(400);
    expect((await post(body,"invalid")).status).toBe(400);
    expect((await post({...body,decision:"approve"})).status).toBe(400);
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("delegates a verified same-company reject with the existing audit parameters", async () => {
    process.env[flag] = "true";
    mocks.legacy.mockReturnValue({email:"review@example.com",role:"admin",companyId:1});
    const result = await post(body);
    expect(result.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(mocks.review).toHaveBeenCalledWith({
      companyId:1,candidateId:41,actorEmail:"review@example.com",
      decision:"reject",reason:"Verified invoice review reason",
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("preserves restore and propagates 409 conflicts without applying a write itself", async () => {
    process.env[flag] = "true";
    mocks.legacy.mockReturnValue({email:"review@example.com",role:"admin",companyId:1});
    mocks.review.mockResolvedValueOnce({id:41,status:"ready"});
    const ok = await post({...body,decision:"restore"});
    expect(ok.status).toBe(200);
    expect(ok.data.candidate).toEqual({id:41,status:"ready"});
    mocks.review.mockRejectedValueOnce(Object.assign(new Error("Transition conflict"), {
      status:409,code:"GMAIL_REVIEW_CONFLICT",
    }));
    const conflict = await post(body);
    expect(conflict.status).toBe(409);
    expect(conflict.data.code).toBe("GMAIL_REVIEW_CONFLICT");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("is unavailable outside DEV even when the flag is true", async () => {
    process.env[flag] = "true";
    mocks.dev.mockReturnValue(false);
    expect((await post(body)).status).toBe(404);
    expect(mocks.review).not.toHaveBeenCalled();
  });
});
