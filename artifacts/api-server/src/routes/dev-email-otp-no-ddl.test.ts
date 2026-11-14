import http from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mail: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("../lib/smtp", () => ({ sendAdminLoginOtpEmail: mocks.mail }));

import otpRouter from "./local-production-auth";

const keys = ["APP_ENV", "NODE_ENV", "SESSION_SECRET", "BIZPORTAL_SESSION_SECRET", "BIZPORTAL_SIGNED_OTP_ENABLED_DEV"] as const;
const original = Object.fromEntries(keys.map(k => [k, process.env[k]])) as Record<(typeof keys)[number], string | undefined>;

describe("DEV OTP never creates schema as a request side effect", () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { log: { error: () => void } }).log = { error: () => undefined };
      next();
    });
    app.use("/api", otpRouter);
    app.use((_req, res) => { res.status(404).json({ error: "Not found" }); });
    server = await new Promise<http.Server>(resolve => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(() => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = "dev-only-otp-test-secret-more-than-32-characters";
    delete process.env.BIZPORTAL_SESSION_SECRET;
    delete process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV;
    mocks.query.mockReset();
    mocks.mail.mockReset();
  });
  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  async function send(): Promise<number> {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No local listener");
    const payload = JSON.stringify({ email: "admin@example.com" });
    return await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: addr.port,
        method: "POST",
        path: "/api/auth/email-otp/send",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  it("returns 404 without opt-in and does not touch any database or email service", async () => {
    expect(await send()).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.mail).not.toHaveBeenCalled();
  });

  it("fails closed when the pre-existing DEV OTP table is absent, without DDL", async () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    mocks.query.mockResolvedValue({ rows: [{ present: false }] });
    expect(await send()).toBe(503);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).toContain("to_regclass");
    expect(mocks.mail).not.toHaveBeenCalled();
  });

  it("checks existing DEV schema and rate limit without CREATE or email send", async () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ present: true }] };
      if (sql.includes("count(*)::text")) return { rows: [{ count: "3" }] };
      throw new Error("Unexpected query");
    });
    expect(await send()).toBe(202);
    const sql = mocks.query.mock.calls.map(([q]) => String(q));
    expect(sql).toHaveLength(2);
    expect(sql.some(x => /\bcreate\s+(?:table|index)\b/i.test(x))).toBe(false);
    expect(mocks.mail).not.toHaveBeenCalled();
  });
});
