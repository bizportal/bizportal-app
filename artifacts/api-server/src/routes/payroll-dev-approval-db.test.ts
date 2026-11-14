import { afterEach, describe, expect, it, vi } from "vitest";
import { devApprovalDedicatedEnabled, getDevApprovalPool } from "./payroll-dev-approval-db";

const ref = "xssrfshdrtdfupgqwfdw";
const credential = (host: string, user: string) =>
  "postgresql://" + encodeURIComponent(user) + ":ci-only-not-a-real-password@" + host + ":5432/postgres";

describe("separate DEV Payroll approval database identity (source-only)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is disabled without an explicit separate credential", () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_APPROVAL_DATABASE_URL_DEV", "");
    expect(devApprovalDedicatedEnabled()).toBe(false);
    expect(() => getDevApprovalPool()).toThrow("PAYROLL_DEV_APPROVAL_DEDICATED_WRITER_REQUIRED");
  });
  it("rejects the legacy review login, the PROD project and arbitrary hosts", () => {
    vi.stubEnv("APP_ENV", "development");
    const denied = [
      credential("db." + ref + ".supabase.co", "bizportal_payroll_dev"),
      credential("db.nzdweipzckfszczzqtuw.supabase.co", "bizportal_payroll_approver_dev"),
      credential("attacker.example.test", "bizportal_payroll_approver_dev"),
      credential("aws-0-ap-southeast-2.pooler.supabase.com", "bizportal_payroll_approver_dev"),
      credential("aws-0-ap-southeast-2xpoolerxsupabasexcom", "bizportal_payroll_approver_dev." + ref),
      credential("aws-0-ap-southeast-2.pooler.supabase.com.attacker.example", "bizportal_payroll_approver_dev." + ref),
    ];
    for (const url of denied) {
      vi.stubEnv("PAYROLL_APPROVAL_DATABASE_URL_DEV", url);
      expect(devApprovalDedicatedEnabled()).toBe(false);
      expect(() => getDevApprovalPool()).toThrow("PAYROLL_DEV_APPROVAL_DEDICATED_WRITER_REQUIRED");
    }
  });
  it("recognizes only explicitly pinned DEV direct or pooler writer credentials", () => {
    vi.stubEnv("APP_ENV", "development");
    for (const url of [
      credential("db." + ref + ".supabase.co", "bizportal_payroll_approver_dev"),
      credential("aws-0-ap-southeast-2.pooler.supabase.com", "bizportal_payroll_approver_dev." + ref),
    ]) {
      vi.stubEnv("PAYROLL_APPROVAL_DATABASE_URL_DEV", url);
      expect(devApprovalDedicatedEnabled()).toBe(true);
    }
  });
  it("never enables the DEV writer in production", () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("PAYROLL_APPROVAL_DATABASE_URL_DEV",
      credential("db." + ref + ".supabase.co", "bizportal_payroll_approver_dev"));
    expect(devApprovalDedicatedEnabled()).toBe(false);
  });
});
