import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDedicatedPayrollPool } from "@workspace/db";
import type { PoolConfig } from "pg";

const direct = "postgresql://bizportal_payroll_dev:fixture%40password@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres";
const pooler = "postgresql://bizportal_payroll_dev.xssrfshdrtdfupgqwfdw:fixture@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=require";
type EffectiveTls = { ca?: string; rejectUnauthorized?: boolean; servername?: string };
type PgPoolInternals = { options: PoolConfig; Client: new (config: PoolConfig) => { connectionParameters: { host: string; user: string; ssl: EffectiveTls | boolean } } };

describe("dedicated Payroll DEV direct TLS", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(["require", "verify-ca", "verify-full", ""])("validates the effective pg CA and hostname with sslmode %s", async mode => {
    vi.stubEnv("APP_ENV", "development");
    const pool = createDedicatedPayrollPool(direct + (mode ? "?sslmode=" + mode : ""));
    try {
      const internals = pool as unknown as PgPoolInternals;
      const client = new internals.Client(internals.options);
      const params = client.connectionParameters;
      expect(params.host).toBe("db.xssrfshdrtdfupgqwfdw.supabase.co");
      expect(params.user).toBe("bizportal_payroll_dev");
      expect(params.ssl).toMatchObject({rejectUnauthorized:true,servername:params.host});
      const tls = params.ssl as EffectiveTls;
      const cert = new X509Certificate(tls.ca!);
      expect(cert.fingerprint256).toBe("80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
      expect(cert.ca).toBe(true);
      expect(cert.verify(cert.publicKey)).toBe(true);
      const normalized = new URL(internals.options.connectionString!);
      expect(normalized.password).toBe("fixture%40password");
      expect(normalized.searchParams.has("sslmode")).toBe(false);
    } finally { await pool.end(); }
  });
  it.each(["sslmode=disable", "sslmode=require&sslmode=disable", "sslmode=require&ssl=0",
    "sslmode=require&host=other.invalid", "sslmode=require&sslrootcert=other.crt"])("rejects unsafe direct DSN query overrides: %s", query => {
    vi.stubEnv("APP_ENV", "development");
    expect(() => createDedicatedPayrollPool(direct + "?" + query)).toThrow("PAYROLL_DEV_DIRECT_TLS_CONFIG_INVALID");
  });
  it.each([
    ["development", pooler],
    ["development", "postgresql://fixture:fixture@127.0.0.1:5432/payroll_ci"],
    ["production", "postgresql://bizportal_payroll_prod:fixture@db.nzdweipzckfszczzqtuw.supabase.co:5432/postgres?sslmode=require"],
  ])("leaves other transports unchanged (%s)", async (env, url) => {
    vi.stubEnv("APP_ENV", env);
    const pool = createDedicatedPayrollPool(url);
    try {
      const options = (pool as unknown as PgPoolInternals).options;
      expect(options.connectionString).toBe(url);
      expect(options.ssl).toBeUndefined();
    } finally { await pool.end(); }
  });
});
