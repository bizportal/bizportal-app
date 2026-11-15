import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  development: vi.fn(() => true),
  legacy: vi.fn(),
  signed: vi.fn(),
  user: vi.fn(),
  query: vi.fn(),
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: mock.development,
  getDevSession: mock.legacy,
  getProductionSession: mock.signed,
  getProductionUser: mock.user,
}));
vi.mock("@workspace/db", () => ({ pool: { query: mock.query } }));
import purchaseRouter from "./purchase-workflow";

describe("Purchase Workflow: preserve active DEV admin-only authorization", () => {
  let server: http.Server;
  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, "log", {
        value: { error: () => undefined }, configurable: true,
      });
      next();
    });
    app.use(purchaseRouter);
    app.use((_req, res) => res.status(204).end());
    server = await new Promise<http.Server>(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(() => {
    vi.resetAllMocks();
    mock.development.mockReturnValue(true);
    mock.legacy.mockReturnValue(null);
    mock.signed.mockReturnValue(null);
    mock.user.mockResolvedValue(null);
  });
  function call() {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing test server");
    return new Promise<{status: number; body: string}>((resolve, reject) => {
      const request = http.get({
        hostname: "127.0.0.1", port: address.port,
        path: "/purchase-workflow/unmatched-read-only-test-path",
      }, response => {
        let body = "";
        response.on("data", chunk => body += chunk.toString());
        response.on("end", () => resolve({status:response.statusCode ?? 0, body}));
      });
      request.on("error", reject);
    });
  }

  it("rejects anonymous caller with no queries or financial writes", async () => {
    expect((await call()).status).toBe(401);
    expect(mock.query).not.toHaveBeenCalled();
    expect(mock.user).not.toHaveBeenCalled();
  });

  it.each([
    ["admin", 204],
    ["owner", 403],
    ["super_admin", 403],
    ["finance", 403],
    ["accounting", 403],
    ["viewer", 403],
  ] as const)("preserves legacy DEV role %s = %i", async (role, expected) => {
    mock.legacy.mockReturnValue({ id: "dev-1", email: "dev@example.com", role, companyId: null });
    expect((await call()).status).toBe(expected);
    expect(mock.query).not.toHaveBeenCalled();
    expect(mock.user).not.toHaveBeenCalled();
  });

  it("accepts only database-verified signed DEV admin with a valid company binding", async () => {
    mock.signed.mockReturnValue({ id: "otp-1", email: "admin@example.com" });
    mock.user.mockResolvedValue({ id: "otp-1", email:"admin@example.com", role:"admin", companyId:1 });
    expect((await call()).status).toBe(204);
    expect(mock.user).toHaveBeenCalledOnce();
    expect(mock.query).not.toHaveBeenCalled();
  });

  it.each(["owner", "super_admin", "finance", "accounting"])(
    "rejects signed DEV role %s despite verified cookie", async role => {
      mock.signed.mockReturnValue({ id:"otp-1", email:"admin@example.com" });
      mock.user.mockResolvedValue({ id:"otp-1", email:"admin@example.com", role, companyId:1 });
      expect((await call()).status).toBe(403);
      expect(mock.query).not.toHaveBeenCalled();
    },
  );

  it("rejects signed admin with no trusted company binding", async () => {
    mock.signed.mockReturnValue({ id:"otp-1", email:"admin@example.com" });
    mock.user.mockResolvedValue({ id:"otp-1", email:"admin@example.com", role:"admin", companyId:null });
    const result = await call();
    expect(result.status).toBe(403);
    expect(result.body).toContain("COMPANY_SCOPE_MISSING");
    expect(mock.query).not.toHaveBeenCalled();
  });

  it("fails closed when the signed-session user lookup fails", async () => {
    mock.signed.mockReturnValue({ id:"otp-1", email:"admin@example.com" });
    mock.user.mockRejectedValue(new Error("DB unavailable"));
    expect((await call()).status).toBe(503);
    expect(mock.query).not.toHaveBeenCalled();
  });
});
