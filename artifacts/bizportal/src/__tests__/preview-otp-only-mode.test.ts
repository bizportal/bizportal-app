import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

describe("isolated preview email OTP-only login presentation", () => {
  it("requires an explicit build-only opt-in and retains legacy default when unset", () => {
    expect(appSource).toContain(
      'const OTP_ONLY_PREVIEW = import.meta.env.VITE_BIZPORTAL_OTP_ONLY_PREVIEW === "true";',
    );
    expect(appSource).toContain(
      'React.useState<"password" | "otp">(OTP_ONLY_PREVIEW ? "otp" : "password")',
    );
  });

  it("removes the password and WhatsApp choices in the opted-in preview UI", () => {
    expect(appSource).toContain('{!OTP_ONLY_PREVIEW && (');
    expect(appSource).toContain('{mode === "password" && !OTP_ONLY_PREVIEW ? (');
    expect(appSource).toContain(
      '{OTP_ONLY_PREVIEW || loginMode === "email" ? <EmailLoginSection /> : <WaLoginSection />}',
    );
  });

  it("reuses existing signed email OTP and preserves server-verified Super Admin role", () => {
    expect(appSource).toContain('const result = await sendEmailOtp(email)');
    expect(appSource).toContain('const result = await verifyEmailOtp(email, code)');
    expect(appSource).toContain('writeRoleCache(result.user?.role ?? null)');
    expect(appSource).not.toContain('writeRoleCache("admin")');
  });
});
