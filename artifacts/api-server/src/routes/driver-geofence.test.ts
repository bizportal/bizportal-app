import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dev: vi.fn(),
  legacy: vi.fn(),
  signed: vi.fn(),
  verified: vi.fn(),
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: mocks.dev,
  getDevSession: mocks.legacy,
  getProductionSession: mocks.signed,
  getProductionUser: mocks.verified,
}));
import router from "./driver-geofence";

describe("legacy-compatible driver geofence dashboard endpoints", () => {
  let server: http.Server;
  beforeAll(async () => {
    const app = express();
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
    mocks.dev.mockReturnValue(true);
    mocks.legacy.mockReturnValue(null);
    mocks.signed.mockReturnValue(null);
    mocks.verified.mockResolvedValue(null);
  });
  async function call(path: string, method = "GET"): Promise<{status: number; text: string}> {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw Error("Missing port");
    return await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port: addr.port, path: "/api" + path, method,
      }, res => {
        let text = "";
        res.on("data", part => { text += part.toString(); });
        res.on("end", () => resolve({status: res.statusCode ?? 0, text}));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("rejects an anonymous request rather than revealing geofence projection", async () => {
    expect((await call("/drivers/geofence-alerts")).status).toBe(401);
    expect(mocks.verified).not.toHaveBeenCalled();
  });
  it("preserves legacy DEV session: authenticated empty alert projection", async () => {
    mocks.legacy.mockReturnValue({email: "operator@example.com"});
    const result = await call("/drivers/geofence-alerts");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual([]);
    expect(mocks.verified).not.toHaveBeenCalled();
  });
  it("preserves idempotent no-op resolve contract without writing an alert", async () => {
    mocks.legacy.mockReturnValue({email: "operator@example.com"});
    const result = await call("/drivers/geofence-alerts/123/resolve", "POST");
    expect(result.status).toBe(404);
    expect(JSON.parse(result.text)).toEqual({error: "Alert not found or already resolved"});
  });
  it("accepts only a DB-verified signed actor when legacy session is absent", async () => {
    mocks.signed.mockReturnValue({email: "operator@example.com"});
    mocks.verified.mockResolvedValue({email: "operator@example.com"});
    expect((await call("/drivers/geofence-alerts")).status).toBe(200);
    mocks.verified.mockResolvedValue(null);
    expect((await call("/drivers/geofence-alerts")).status).toBe(401);
  });
  it("preserves signed-session authorization outside development", async () => {
    mocks.dev.mockReturnValue(false);
    mocks.signed.mockReturnValue({email: "operator@example.com"});
    mocks.verified.mockResolvedValue({email: "operator@example.com"});
    expect((await call("/drivers/geofence-alerts")).status).toBe(200);
  });
});
