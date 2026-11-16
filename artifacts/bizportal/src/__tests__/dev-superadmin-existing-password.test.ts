import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const auth = readFileSync(resolve(process.cwd(), "src/contexts/SupabaseAuthContext.tsx"), "utf8");

describe("existing Super Admin password login on PR81 DEV preview", () => {
  it("returns the server-verified user from the existing password login context", () => {
    const start = auth.indexOf("const signInWithEmail = useCallback");
    const end = auth.indexOf("const sendEmailOtp = useCallback", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const source = auth.slice(start, end);
    expect(source).toContain('fetch("/api/auth/email-login"');
    expect(source).toContain("return { error: null, user: data.user }");
    expect(source).toContain("writeCache(data.user)");
    expect(source).toContain("setUser(data.user)");
  });

  it("keeps the actual Super Admin role rather than hardcoding admin", () => {
    const start = app.indexOf("const handlePasswordSubmit = async");
    const end = app.indexOf("const handleSendOtp = async", start);
    expect(start).toBeGreaterThan(0);
    const source = app.slice(start, end);
    expect(source).toContain("await signInWithEmail(email, password)");
    expect(source).toContain("result.user?.role ?? null");
    expect(source).not.toContain('writeRoleCache("admin")');
    expect(app).toMatch(/case "super_admin":\s*case "admin":\s*return "\/dashboard"/);
  });

  it("only hides the unused OTP tab in explicitly password-only preview builds", () => {
    expect(app).toContain('import.meta.env.VITE_BIZPORTAL_DEV_PASSWORD_ONLY === "true"');
    expect(app).toContain("{!passwordOnlyPreview && (");
    expect(app).toContain('placeholder={passwordOnlyPreview ? "Password Super Admin"');
    expect(app).toContain('const loginMode = passwordOnlyPreview ? "password"');
  });
});
