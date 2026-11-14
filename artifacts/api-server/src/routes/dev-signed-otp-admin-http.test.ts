import http from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));

import { authenticateAdmin, type AdminRequest } from "./admin-auth";
import { createDevAuthRouter, setProductionSessionCookie } from "./dev-auth";

const envKeys = ["APP_ENV", "NODE_ENV", "SESSION_SECRET", "BIZPORTAL_SESSION_SECRET", "BIZPORTAL_SIGNED_OTP_ENABLED_DEV", "DEV_LOGIN_EMAILS", "DEV_LOGIN_ROLE"] as const;
const original = Object.fromEntries(envKeys.map(k => [k, process.env[k]])) as Record<(typeof envKeys)[number], string | undefined>;

describe("signed OTP HTTP admin middleware under explicit DEV opt-in", () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(createDevAuthRouter());
    app.get("/protected", authenticateAdmin, (req, res) => {
      const user = (req as AdminRequest).adminUser;
      res.json({ email: user?.email, role: user?.role, companyId: user?.companyId });
    });
    server = await new Promise<http.Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = "dev-otp-verified-user-session-secret-32-plus";
    delete process.env.BIZPORTAL_SESSION_SECRET;
    delete process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV;
    process.env.DEV_LOGIN_EMAILS = "admin@example.com";
    process.env.DEV_LOGIN_ROLE = "admin";
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({
      rows: [{
        user_data: {
          id: "user-verified",
          email: "admin@example.com",
          role: "admin",
          is_active: true,
          company_id: 7,
        },
      }],
    });
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  function cookie(): string {
    let issued = "";
    const fakeResponse = {
      append: (key: string, value: string) => {
        if (key === "Set-Cookie") issued = value;
        return fakeResponse;
      },
    } as unknown as Response;
    setProductionSessionCookie(fakeResponse, {
      id: "user-verified",
      email: "admin@example.com",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    return issued.split(";")[0];
  }

  async function legacyDevCookie(): Promise<string> {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing test port");
    const response = await fetch("http://127.0.0.1:" + address.port + "/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com" }),
    });
    expect(response.status).toBe(200);
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toContain("bizportal_dev_session=");
    return header.split(";")[0];
  }

  async function call(sentCookie?: string, path = "/protected"): Promise<{status: number; body: Record<string, unknown>}> {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing test port");
    const result = await new Promise<{status: number; body: string}>((resolve, reject) => {
      const req = http.get({
        hostname: "127.0.0.1",
        port: address.port,
        path,
        headers: sentCookie ? { cookie: sentCookie } : {},
      }, (res) => {
        let body = "";
        res.on("data", (part) => { body += part.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
    });
    return { status: result.status, body: JSON.parse(result.body) as Record<string, unknown> };
  }

  it("rejects signed OTP cookies by default with no user database query", async () => {
    const res = await call(cookie());
    expect(res.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("accepts only a DB-verified signed admin and preserves company ID", async () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    const res = await call(cookie());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: "admin@example.com", role: "admin", companyId: 7 });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("prefers DB-verified signed OTP to a simultaneous valid legacy DEV cookie", async () => {
    const legacy = await legacyDevCookie();
    const both = legacy + "; " + cookie();
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";

    const route = await call(both);
    expect(route.status).toBe(200);
    expect(route.body).toEqual({ email: "admin@example.com", role: "admin", companyId: 7 });

    const profile = await call(both, "/auth/user");
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ user: { email: "admin@example.com", role: "admin", companyId: 7 } });

    const me = await call(both, "/users/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: "admin@example.com", role: "admin" });
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("does not fall back to a legacy cookie when the signed DB user is inactive", async () => {
    const both = await legacyDevCookie() + "; " + cookie();
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    mocks.query.mockResolvedValue({ rows: [{ user_data: {
      email: "admin@example.com", role: "admin", is_active: false,
      status: "inactive", company_id: 7,
    } }] });
    expect((await call(both)).status).toBe(401);
    expect((await call(both, "/auth/user")).status).toBe(403);
    expect((await call(both, "/users/me")).status).toBe(403);
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("rejects a signed OTP session when its database user ID is replaced", async () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    const both = await legacyDevCookie() + "; " + cookie();
    mocks.query.mockResolvedValue({ rows: [{ user_data: {
      id: "different-user-id", email: "admin@example.com", role: "admin",
      company_id: 7, is_active: true, status: "active",
    } }] });
    // The same email is not sufficient to inherit another account's identity.
    expect((await call(both)).status).toBe(401);
    expect((await call(both, "/auth/user")).status).toBe(403);
    expect((await call(both, "/users/me")).status).toBe(403);
  });

  it("retains legacy DEV authorization when signed OTP is OFF", async () => {
    const both = await legacyDevCookie() + "; " + cookie();
    const route = await call(both);
    expect(route.status).toBe(200);
    expect(route.body).toEqual({ email: "admin@example.com", role: "admin", companyId: null });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects forged sessions before accessing the database", async () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    const res = await call("bizportal_supabase_session=forged.invalid");
    expect(res.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects an inactive signed admin even with a valid signature", async () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    mocks.query.mockResolvedValue({ rows: [{ user_data: {
      email: "admin@example.com", role: "admin", company_id: 7,
      is_active: false, status: "inactive",
    } }] });
    const res = await call(cookie());
    expect(res.status).toBe(401);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("rejects authenticated users without an admin role", async () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    mocks.query.mockResolvedValue({rows:[{user_data:{id:"user-verified",email:"admin@example.com",role:"viewer",company_id:7,is_active:true,status:"active"}}]});
    const res = await call(cookie());
    expect(res.status).toBe(403);
  });
});
