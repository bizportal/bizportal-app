import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");

describe("Gmail source canonical manual-only contract", () => {
  it("never registers a startup Gmail organizer timer", () => {
    expect(source).not.toContain("runGmailOrganizerTick");
    expect(source).not.toContain("GMAIL_ORGANIZER_POLL_MS");
    expect(source).not.toContain("setInterval(");
    expect(source).not.toContain("setTimeout(");
  });

  it("reports manual sync status to the existing DEV frontend", () => {
    expect(source).toContain("autoSyncEnabled: false");
    expect(source).toContain("autoSyncIntervalMinutes: 0");
  });

  it("retains DEV-only source mailbox isolation and protected manual sync", () => {
    expect(source).toContain("GMAIL_DEV_SOURCE_EMAIL_REQUIRED");
    expect(source).toContain("async function requireFinanceAdmin(");
    expect(source).toContain("const companyId = requireCompanyScope(");
  });
});
