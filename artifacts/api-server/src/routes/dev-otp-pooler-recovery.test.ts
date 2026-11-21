import { describe, it, expect } from "vitest";
import { recoverCstDevSessionPoolerUrl } from "../../../../lib/db/src/connection";

describe("CST DEV Supavisor OTP database connectivity recovery", () => {
  const dev = "postgresql://postgres.xssrfshdrtdfupgqwfdw:secret%40test@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=require";
  it("switches exact CST-DEV session pooler to validated transaction port only", () => {
    const result = recoverCstDevSessionPoolerUrl(dev, "development");
    expect(result).toBe(dev.replace(":5432/postgres", ":6543/postgres"));
    expect(new URL(result).password).toBe("secret%40test");
    expect(new URL(result).searchParams.get("sslmode")).toBe("require");
  });
  it("never changes PROD, including a DEV-looking input", () => {
    expect(recoverCstDevSessionPoolerUrl(dev, "production")).toBe(dev);
    const prod = "postgresql://postgres.nzdweipzckfszczzqtuw:secret@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres";
    expect(recoverCstDevSessionPoolerUrl(prod, "production")).toBe(prod);
    expect(recoverCstDevSessionPoolerUrl(prod, "development")).toBe(prod);
  });
  it("does not change another project, hostname, port, or direct DB endpoint", () => {
    const otherTenant = dev.replace("postgres.xssrfshdrtdfupgqwfdw", "postgres.other");
    const otherHost = dev.replace("aws-1-ap-southeast-2.pooler.supabase.com", "aws-0-ap-southeast-2.pooler.supabase.com");
    const transaction = dev.replace(":5432/", ":6543/");
    const direct = "postgresql://postgres:secret@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres";
    for (const value of [otherTenant, otherHost, transaction, direct]) {
      expect(recoverCstDevSessionPoolerUrl(value, "development")).toBe(value);
    }
  });
  it("keeps original credential and unrelated URL components intact", () => {
    const url = dev.replace("secret%40test", "q%24%25%23%40private");
    const converted = recoverCstDevSessionPoolerUrl(url, "development");
    expect(converted.replace(":6543/postgres", ":5432/postgres")).toBe(url);
    expect(converted).not.toContain("undefined");
  });
});
