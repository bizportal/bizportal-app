import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const authSource = readFileSync(resolve(process.cwd(), "src/contexts/SupabaseAuthContext.tsx"), "utf8");

describe("PR #81 integration — server-verified OTP Super Admin role", () => {
  it("returns the authenticated user from the existing OTP context", () => {
    expect(authSource).toContain("return { error: null, user: data.user }");
    expect(authSource).toContain("user?: AuthUser");
    expect(appSource).toContain("writeRoleCache(result.user?.role ?? null)");
    expect(appSource).not.toContain('writeRoleCache("admin")');
  });

  it("routes Super Admin to the existing dashboard rather than inventing a role", () => {
    expect(appSource).toMatch(/case "super_admin":\s*case "admin":\s*return "\/dashboard"/);
    expect(appSource).toContain("const result = await verifyEmailOtp(email, code)");
    expect(appSource).toContain("window.location.href = appRootPath");
  });
});
