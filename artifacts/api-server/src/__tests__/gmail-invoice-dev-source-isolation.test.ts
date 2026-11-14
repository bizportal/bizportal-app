import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gmailConfigEnvironment } from "../lib/gmail-invoice-runtime";

const route = readFileSync(resolve(process.cwd(), "src/routes/gmail-invoice-source.ts"), "utf8");
const runtime = readFileSync(resolve(process.cwd(), "src/lib/gmail-invoice-runtime.ts"), "utf8");

describe("official BizPortal DEV Gmail invoice isolation", () => {
  it("selects development config without falling back to production app_config", () => {
    expect(gmailConfigEnvironment("development", "production")).toBe("development");
    expect(gmailConfigEnvironment("production", "development")).toBe("production");
    expect(gmailConfigEnvironment(undefined, "test")).toBe("development");
    expect(runtime).toContain("environment in ('all',$2)");
    expect(runtime).toContain("[key, gmailConfigEnvironment()]");
    expect(runtime).not.toContain("environment in ('all','production')");
  });
  it("requires an explicit DEV-only mailbox for Connect and Sync", () => {
    expect(route).toContain("isDevelopmentEnvironment() ? configured : configured || DEFAULT_SOURCE_EMAIL");
    expect(route.match(/GMAIL_DEV_SOURCE_EMAIL_REQUIRED/g)).toHaveLength(2);
  });
  it("does not borrow general OAuth credentials in DEV", () => {
    expect(route.match(/if \(isDevelopmentEnvironment\(\)\) return dedicated;/g)).toHaveLength(2);
    expect(route).toContain('return dedicated || await getRuntimeConfig("GOOGLE_CLIENT_ID")');
    expect(route).toContain('return dedicated || await getRuntimeConfig("GOOGLE_CLIENT_SECRET")');
  });
  it("persists Gmail config with correct environment metadata", () => {
    expect(route).toContain("environment=excluded.environment");
    expect(route).toContain('isDevelopmentEnvironment() ? "development" : "production"');
  });
});
