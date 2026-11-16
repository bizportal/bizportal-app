import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  getFinanceCompanyScope, isApprovedFinanceGlobalSuperAdmin, isApprovedFinanceGlobalCompany,
  isFinanceGlobalScopeDevEnabled, setFinanceCompanyScopeCookie,
  type ProductionSession,
} from "./dev-auth";

const envKeys = [
  "APP_ENV", "NODE_ENV", "SESSION_SECRET", "BIZPORTAL_SESSION_SECRET",
  "BIZPORTAL_SIGNED_OTP_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV",
  "BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV",
  "BIZPORTAL_FINANCE_GLOBAL_SUPERADMIN_EMAILS_DEV",
  "BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV",
] as const;
const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const session = (): ProductionSession => ({
  id: "account1", email: "admin@example.test",
  issuedAt: 100, expiresAt: Date.now() + 3600000,
});
beforeEach(() => {
  process.env.APP_ENV = "development";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "synthetic-test-secret-value-for-issue76-only";
  delete process.env.BIZPORTAL_SESSION_SECRET;
  process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV = "true";
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV;
  process.env.BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV = "true";
  process.env.BIZPORTAL_FINANCE_GLOBAL_SUPERADMIN_EMAILS_DEV = "admin@example.test";
  process.env.BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV = "1,3";
});
afterEach(() => {
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});
function issued(companyId: number, identity = session()) {
  const cookies: string[] = [];
  const res = {
    append: (header: string, value: string) => {
      if (header === "Set-Cookie") cookies.push(value);
    },
    setHeader: vi.fn(),
  } as unknown as Response;
  setFinanceCompanyScopeCookie(res, identity, companyId);
  const value = cookies[0].split(";")[0];
  const req = { headers: { cookie: value } } as Request;
  return { req, cookies, res, value };
}

describe("Issue76 DEV Finance scope signature and session binding", () => {
  it("permits signed scoped company in GET-only mode while Writer remains OFF", () => {
    delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
    process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV = "true";
    expect(isFinanceGlobalScopeDevEnabled()).toBe(true);
    const { req } = issued(1);
    expect(getFinanceCompanyScope(req, session())).toBe(1);
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV;
    expect(isFinanceGlobalScopeDevEnabled()).toBe(false);
  });
  it("is disabled by default and requires a signed OTP session", () => {
    delete process.env.BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV;
    expect(isFinanceGlobalScopeDevEnabled()).toBe(false);
    expect(() => issued(1)).toThrow();
    process.env.BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV = "true";
    delete process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV;
    expect(isFinanceGlobalScopeDevEnabled()).toBe(false);
  });
  it("requires an exact allowlisted global email", () => {
    expect(isApprovedFinanceGlobalSuperAdmin(" ADMIN@example.test ")).toBe(true);
    expect(isApprovedFinanceGlobalSuperAdmin("other@example.test")).toBe(false);
    process.env.BIZPORTAL_FINANCE_GLOBAL_SUPERADMIN_EMAILS_DEV = "*";
    expect(isApprovedFinanceGlobalSuperAdmin("admin@example.test")).toBe(false);
  });
  it("rejects any company not explicitly allowed by the server", () => {
    expect(isApprovedFinanceGlobalCompany(1)).toBe(true);
    expect(isApprovedFinanceGlobalCompany(3)).toBe(true);
    expect(isApprovedFinanceGlobalCompany(2)).toBe(false);
    expect(() => issued(2)).toThrow();
    delete process.env.BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV;
    expect(isApprovedFinanceGlobalCompany(1)).toBe(false);
  });
  it("creates a Secure HttpOnly cookie limited to Finance paths", () => {
    const actor = session();
    const { req, cookies, res } = issued(1, actor);
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("Secure");
    expect(cookies[0]).toContain("SameSite=Strict");
    expect(cookies[0]).toContain("Path=/api/mkt/admin");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(getFinanceCompanyScope(req, actor)).toBe(1);
  });
  it("rejects tampering and replay for a different OTP session", () => {
    const actor = session();
    const { req, value } = issued(3, actor);
    const altered = value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
    expect(getFinanceCompanyScope({ headers: { cookie: altered } } as Request, actor)).toBeNull();
    expect(getFinanceCompanyScope(req, { ...actor, id: "different" })).toBeNull();
    expect(getFinanceCompanyScope(req, { ...actor, email: "other@example.test" })).toBeNull();
    expect(getFinanceCompanyScope(req, { ...actor, issuedAt: 101 })).toBeNull();
    expect(getFinanceCompanyScope(req, { ...actor, expiresAt: Date.now()-1000 })).toBeNull();
  });
  it("rejects invalid company and the absence of a scoped selection", () => {
    expect(() => issued(0)).toThrow();
    expect(() => issued(-1)).toThrow();
    expect(() => issued(1.5)).toThrow();
    expect(getFinanceCompanyScope({ headers: {} } as Request, session())).toBeNull();
    const actor = session();
    const { req } = issued(1, actor);
    delete process.env.BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV;
    expect(getFinanceCompanyScope(req, actor)).toBeNull();
  });
});
