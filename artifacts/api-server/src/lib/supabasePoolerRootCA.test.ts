import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SUPABASE_POOLER_ROOT_2021_CA } from "./supabasePoolerRootCA";
import { readFileSync } from "node:fs";

describe("PR147 Supabase DEV reader TLS trust anchor", () => {
  it("pins the known public Supabase Root 2021 CA fingerprint and CA:true", () => {
    const cert = new X509Certificate(SUPABASE_POOLER_ROOT_2021_CA);
    expect(cert.fingerprint256).toBe("80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain("Supabase Root 2021 CA");
  });
  it("preserves cert and hostname verification for the scoped reader", () => {
    const source = readFileSync(new URL("./bankSheetScopedReader.ts", import.meta.url), "utf8");
    expect(source).toContain("ca: SUPABASE_POOLER_ROOT_2021_CA, rejectUnauthorized: true, servername: parsed.hostname");
    expect(source).toContain('parsed.hostname !== "aws-1-ap-southeast-2.pooler.supabase.com"');
    expect(source).not.toContain("rejectUnauthorized: false");
  });
});
