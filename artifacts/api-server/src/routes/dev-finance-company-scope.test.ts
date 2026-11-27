import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import {
  getFinanceCompanyScope,
  isFinanceGlobalScopeDevEnabled,
  setFinanceCompanyScopeCookie,
  type ProductionSession,
} from "./dev-auth";

const keys = [
  "APP_ENV", "SESSION_SECRET", "BIZPORTAL_SESSION_SECRET",
  "BIZPORTAL_SIGNED_OTP_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_READONLY_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV",
  "BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV",
  "BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV",
  "BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV",
  "BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV",
  "BIZPORTAL_CUSTOMER_AR_PREVIEW_ENABLED_DEV",
] as const;
const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));

function fakeResponse() {
  const cookies: string[] = [];
  const response = {
    append: (header: string, value: string) => {
      if (header === "Set-Cookie") cookies.push(value);
    },
    setHeader: () => undefined,
  } as unknown as Response;
  return { response, cookies };
}

const signedSession = (): ProductionSession => ({
  id: "user-42",
  email: "owner@example.test",
  issuedAt: Date.now() - 2000,
  expiresAt: Date.now() + 3600000,
});

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  process.env.APP_ENV = "development";
  process.env.SESSION_SECRET = "test-only-signed-session-secret-at-least-32-characters";
  process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV = "true";
  process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV = "true";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV = "true";
  process.env.BIZPORTAL_FINANCE_GLOBAL_SCOPE_ENABLED_DEV = "true";
  process.env.BIZPORTAL_FINANCE_GLOBAL_COMPANY_IDS_DEV = "1,3";
});

afterEach(() => {
  for (const key of keys) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

describe("signed Finance scope — narrow cookie paths", () => {
  it("supports approval-only Finance scope without activating the general writer", () => {
    expect(isFinanceGlobalScopeDevEnabled()).toBe(true);
    expect(process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV).toBeUndefined();
    const { response, cookies } = fakeResponse();
    const session = signedSession();
    process.env.BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV = "true";
    setFinanceCompanyScopeCookie(response, session, 3);
    expect(cookies).toHaveLength(2);
    expect(cookies.some(c => c.includes("Path=/api/mkt/admin;"))).toBe(true);
    expect(cookies.some(c => c.includes("Path=/api/bank-reconciliation;"))).toBe(true);
    expect(cookies.every(c => c.includes("HttpOnly; Secure; SameSite=Strict"))).toBe(true);
    const token = cookies[1].split(";")[0];
    const req = { headers: { cookie: token } } as unknown as Request;
    expect(getFinanceCompanyScope(req, session)).toBe(3);
    expect(getFinanceCompanyScope(req, { ...session, id: "another-user" })).toBeNull();
  });

  it("never emits the bank cookie while the bank adapter flag is OFF", () => {
    const { response, cookies } = fakeResponse();
    setFinanceCompanyScopeCookie(response, signedSession(), 1);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("Path=/api/mkt/admin;");
    expect(cookies[0]).not.toContain("Path=/api/bank-reconciliation;");
  });

  it("permits signed company selection for isolated QA without canonical Finance writers", () => {
    delete process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV;
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV;
    process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV = "true";
    expect(isFinanceGlobalScopeDevEnabled()).toBe(true);
    const { response, cookies } = fakeResponse();
    setFinanceCompanyScopeCookie(response, signedSession(), 1);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("Path=/api/mkt/admin;");
    expect(process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV).toBeUndefined();
  });

  it("rejects unallowlisted tenants and disabled approval-only mode", () => {
    const { response, cookies } = fakeResponse();
    expect(() => setFinanceCompanyScopeCookie(response, signedSession(), 2))
      .toThrow("DEV_FINANCE_GLOBAL_SCOPE_DISABLED_OR_INVALID");
    expect(cookies).toHaveLength(0);
    delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV;
    expect(isFinanceGlobalScopeDevEnabled()).toBe(false);
    expect(() => setFinanceCompanyScopeCookie(response, signedSession(), 1))
      .toThrow("DEV_FINANCE_GLOBAL_SCOPE_DISABLED_OR_INVALID");
  });
});
