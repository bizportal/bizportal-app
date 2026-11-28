import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDedicatedPayrollPool, verifiedPayrollReaderConnectionString } from "@workspace/db";

const example = "postgresql://bizportal_payroll_dev:dummy%40password@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=require&application_name=payroll-test";

describe("Dedicated DEV Payroll connection retains verified TLS", () => {
  it("preserves account, host and non-TLS settings without changing environment", () => {
    const original = process.env.PAYROLL_DATABASE_URL_DEV;
    const result = new URL(verifiedPayrollReaderConnectionString(example));
    expect(result.hostname).toBe("db.xssrfshdrtdfupgqwfdw.supabase.co");
    expect(result.username).toBe("bizportal_payroll_dev");
    expect(result.password).toBe("dummy%40password");
    expect(result.searchParams.get("application_name")).toBe("payroll-test");
    expect(result.searchParams.has("sslmode")).toBe(false);
    expect(process.env.PAYROLL_DATABASE_URL_DEV).toBe(original);
  });

  it("uses the official public Supabase Root CA and refuses unverified certificates", async () => {
    const pool = createDedicatedPayrollPool(example);
    try {
      const options = (pool as unknown as { options: { ssl: { ca: string; rejectUnauthorized: boolean }; connectionString: string } }).options;
      expect(options.ssl.rejectUnauthorized).toBe(true);
      const ca = new X509Certificate(options.ssl.ca);
      expect(ca.subject).toContain("Supabase Root 2021 CA");
      expect(ca.fingerprint256).toBe(
        "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
      );
      expect(new URL(options.connectionString).searchParams.has("sslmode")).toBe(false);
    } finally {
      await pool.end();
    }
  });

  it("never accepts a non-PostgreSQL connection URL", () => {
    expect(() => verifiedPayrollReaderConnectionString("http://example.invalid/x")).toThrow("INVALID_PAYROLL_DB_SCHEME");
  });
});
