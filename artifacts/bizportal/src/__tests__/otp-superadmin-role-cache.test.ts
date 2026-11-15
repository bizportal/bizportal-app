import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const authSource = readFileSync(resolve(process.cwd(), "src/contexts/SupabaseAuthContext.tsx"), "utf8");

describe("Issue #76 verified Super Admin OTP presentation regressions", () => {
  it("keeps the server-returned identity after OTP verification", () => {
    expect(authSource).toContain("return { error: null, user: data.user }");
    expect(appSource).toContain("writeRoleCache(result.user?.role ?? null)");
    expect(appSource).not.toContain('writeRoleCache("admin")');
  });
  it("routes a signed Super Admin to the existing dashboard, without a new login system", () => {
    expect(appSource).toMatch(/case "super_admin":\s*case "admin":\s*return "\/dashboard"/);
    expect(appSource).toContain("const result = await verifyEmailOtp(email, code)");
    expect(appSource).toContain("window.location.href = appRootPath");
  });
});
