import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/pages/finance/recon-config/InvoiceSourcesTab.tsx"), "utf8");

describe("official Gmail Invoice Source mailbox UI", () => {
  it("does not display the operational PROD inbox as the DEV fallback", () => {
    expect(source).not.toContain("travelincars01@gmail.com");
    expect(source).toContain('"Mailbox sumber belum dikonfigurasi"');
  });
  it("explains the dedicated DEV mailbox dependency", () => {
    expect(source).toContain("!status.expectedEmail?.trim()");
    expect(source).toContain("GMAIL_INVOICE_SOURCE_EMAIL");
    expect(source).toContain("inbox PROD");
  });
  it("locks Connect, Reconnect and Sync Now when mailbox is missing", () => {
    expect(source).toContain("!status?.oauthConfigured ||\n                      !status?.expectedEmail?.trim()");
    expect(source).toContain("!status.aiConfigured ||\n                        !status.expectedEmail?.trim()");
    expect(source).toContain("!status.oauthConfigured ||\n                        !status.expectedEmail?.trim()");
  });
});
