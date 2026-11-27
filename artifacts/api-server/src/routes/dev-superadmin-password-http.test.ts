import express from "express";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  userRole: "super_admin",
  userSystemRole: "super_admin",
  userStatus: "active",
  userActive: true,
  companyId: null as number | null,
  duplicateActive: false,
}));
vi.mock("@workspace/db", () => ({
  pool: { query: mock.query },
  getRuntimeDatabaseUrl: vi.fn(),
}));
vi.mock("../lib/smtp", () => ({ sendAdminLoginOtpEmail: vi.fn() }));

import { createDevAuthRouter, isFinanceGlobalScopeDevEnabled } from "./dev-auth";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";
import localProductionAuthRouter from "./local-production-auth";

const EMAIL = "admin.test@example.invalid";
const ID = "dev-password-admin-1";
const PASS = "fixture-existing-superadmin-password";
const KEYS = [
  "APP_ENV", "NODE_ENV", "SESSION_SECRET", "BIZPORTAL_SESSION_SECRET",
  "BIZPORTAL_SIGNED_OTP_ENABLED_DEV", "BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV",
  "BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_ID_DEV",
  "BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV", "DEV_LOGIN_EMAILS",
  "BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
let server: Server;
let base: string;
let passwordHash = "";

async function req(path: string, options: RequestInit = {}) {
  const response = await fetch(base + path, options);
  return { response, data: await response.json().catch(() => null) as Record<string, any> | null };
}
const post = (path: string, body: Record<string, unknown>) =>
  req(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("one existing Super Admin password -> signed DEV session (PR81 opt-in only)", () => {
  beforeAll(async () => {
    passwordHash = await hash(PASS, 4);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
      (request as any).log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
      next();
    });
    app.use("/api", createDevAuthRouter());
    app.use("/api", localProductionAuthRouter);
    app.get("/api/test/protected-admin", authenticateAdmin, (request, response) => {
      const actor = (request as AdminRequest).adminUser;
      response.json({ ok: true, role: actor?.role, companyId: actor?.companyId });
    });
    app.use((_request, response) => { response.status(404).json({ error: "Not found" }); });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Test listener unavailable");
    base = "http://127.0.0.1:" + address.port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  beforeEach(() => {
    mock.query.mockReset();
    mock.userRole = "super_admin";
    mock.userSystemRole = "super_admin";
    mock.userStatus = "active";
    mock.userActive = true;
    mock.companyId = null;
    mock.duplicateActive = false;
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "production"; // exact bundled DEV runtime mode
    process.env.SESSION_SECRET = "signed-dev-password-test-key-longer-than-thirty-two-characters";
    delete process.env.BIZPORTAL_SESSION_SECRET;
    delete process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV;
    process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV = "true";
    process.env.BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_ID_DEV = ID;
    process.env.BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_EMAIL_DEV = EMAIL;
    process.env.DEV_LOGIN_EMAILS = EMAIL;
    delete process.env.BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV;
    delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
    mock.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("to_jsonb(u)")) {
        if (sql.includes("where u.id = $1")
          && (params?.[0] !== ID || params?.[1] !== EMAIL)) return { rows: [] };
        return { rows: mock.duplicateActive ? [] : [{
          user_data: {
            id: ID, email: EMAIL, role: mock.userRole,
            system_role: mock.userSystemRole,
            status: mock.userStatus, is_active: mock.userActive,
            company_id: mock.companyId, password_hash: passwordHash,
          },
        }] };
      }
      throw Error("Unexpected DB statement (writes forbidden in this test)");
    });
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("signs one session from the existing password, caches real role and rechecks the account", async () => {
    const { response, data } = await post("/api/auth/email-login", { email: EMAIL, password: PASS });
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ user: { id: ID, email: EMAIL, role: "super_admin", companyId: null } });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("bizportal_supabase_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    const me = await req("/api/auth/user", { headers: { Cookie: cookie.split(";")[0] } });
    expect(me.response.status).toBe(200);
    expect(me.data).toMatchObject({ user: { id: ID, role: "super_admin" } });
    expect(mock.query).toHaveBeenCalledTimes(2);
    expect(mock.query.mock.calls.every(([sql]) => String(sql).includes("not exists"))).toBe(true);
  });

  it("rejects wrong password with no cookie and no privilege change", async () => {
    const { response } = await post("/api/auth/email-login", { email: EMAIL, password: "wrong" });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mock.query).toHaveBeenCalledTimes(1);
  });

  it("rejects other email before any DB lookup", async () => {
    const { response } = await post("/api/auth/email-login", { email: "other@example.invalid", password: PASS });
    expect(response.status).toBe(401);
    expect(mock.query).not.toHaveBeenCalled();
  });

  it.each([
    ["role demoted", () => { mock.userRole = "admin"; }],
    ["canonical system role removed", () => { mock.userSystemRole = ""; }],
    ["canonical system role downgraded", () => { mock.userSystemRole = "admin"; }],
    ["account suspended", () => { mock.userActive = false; }],
    ["status inactive", () => { mock.userStatus = "inactive"; }],
    ["company changed", () => { mock.companyId = 1; }],
    ["second active email account", () => { mock.duplicateActive = true; }],
  ])("denies %s", async (_label, change) => {
    change();
    const { response } = await post("/api/auth/email-login", { email: EMAIL, password: PASS });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("accepts a signed password session in the existing Admin middleware", async () => {
    const login = await post("/api/auth/email-login", { email: EMAIL, password: PASS });
    expect(login.response.status).toBe(200);
    const cookie = (login.response.headers.get("set-cookie") ?? "").split(";")[0];
    const protectedRoute = await req("/api/test/protected-admin", { headers: { Cookie: cookie } });
    expect(protectedRoute.response.status).toBe(200);
    expect(protectedRoute.data).toMatchObject({ ok: true, role: "super_admin", companyId: null });
  });

  it.each([
    ["role downgraded", () => { mock.userRole = "admin"; }],
    ["canonical system role removed", () => { mock.userSystemRole = ""; }],
    ["canonical system role downgraded", () => { mock.userSystemRole = "finance"; }],
    ["status changed", () => { mock.userStatus = "suspended"; }],
    ["company attached", () => { mock.companyId = 3; }],
    ["account suspended", () => { mock.userActive = false; }],
    ["same-email active duplicate", () => { mock.duplicateActive = true; }],
  ])("revokes both current-user and shared Admin sessions when %s after login", async (_label, change) => {
    const login = await post("/api/auth/email-login", { email: EMAIL, password: PASS });
    expect(login.response.status).toBe(200);
    const cookie = (login.response.headers.get("set-cookie") ?? "").split(";")[0];
    change();
    const me = await req("/api/auth/user", { headers: { Cookie: cookie } });
    expect(me.response.status).toBe(403);
    const protectedRoute = await req("/api/test/protected-admin", { headers: { Cookie: cookie } });
    expect(protectedRoute.response.status).toBe(401);
  });

  it("revokes previously signed session after account deactivation", async () => {
    const login = await post("/api/auth/email-login", { email: EMAIL, password: PASS });
    expect(login.response.status).toBe(200);
    mock.userActive = false;
    const me = await req("/api/auth/user", {
      headers: { Cookie: (login.response.headers.get("set-cookie") ?? "").split(";")[0] },
    });
    expect(me.response.status).toBe(403);
  });

  it("blocks legacy email-only DEV login and identity enumeration when password auth is selected", async () => {
    expect((await req("/api/auth/dev-users")).response.status).toBe(404);
    expect((await post("/api/auth/dev-login", { email: EMAIL })).response.status).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
  });

  it("fails closed when preview password flag, pin or signing secret is missing", async () => {
    delete process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV;
    expect((await post("/api/auth/email-login", { email: EMAIL, password: PASS })).response.status).toBe(404);
    process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV = "true";
    delete process.env.BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_ID_DEV;
    expect((await post("/api/auth/email-login", { email: EMAIL, password: PASS })).response.status).toBe(404);
    expect((await post("/api/auth/dev-login", { email: EMAIL })).response.status).toBe(404);
    process.env.BIZPORTAL_SIGNED_PASSWORD_ACCOUNT_ID_DEV = ID;
    process.env.SESSION_SECRET = "short";
    expect((await post("/api/auth/email-login", { email: EMAIL, password: PASS })).response.status).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
  });

  it("rejects OTP endpoint in password-only DEV without sending email", async () => {
    expect((await post("/api/auth/email-otp/send", { email: EMAIL })).response.status).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
  });

  it("fails closed for both auth modes when OTP and password flags conflict", async () => {
    process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
    expect((await post("/api/auth/email-login", { email: EMAIL, password: PASS })).response.status).toBe(404);
    expect((await post("/api/auth/email-otp/send", { email: EMAIL })).response.status).toBe(404);
    expect((await post("/api/auth/dev-login", { email: EMAIL })).response.status).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
  });

  it("keeps Finance scope disabled without separate company/Finance opt-in flags", () => {
    expect(isFinanceGlobalScopeDevEnabled()).toBe(false);
    process.env.BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV = "true";
    expect(isFinanceGlobalScopeDevEnabled()).toBe(false);
  });

  it("does not make a DEV password session valid on PROD", async () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    // A PRODUCTION credential is still checked by the preexisting code.
    const { response } = await post("/api/auth/email-login", { email: EMAIL, password: "wrong" });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
