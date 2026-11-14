import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const api = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../../../bizportal/src/pages/finance/recon-config/InvoiceSourcesTab.tsx", import.meta.url), "utf8");
const begin = api.indexOf('"/recon-classification/invoice-sources/gmail/verify-connection"');
const end = api.indexOf("// Provisional Match INV discovery", begin);
const preflight = api.slice(begin, end);

describe("canonical Gmail DEV provider-profile preflight", () => {
  it("keeps the route default-OFF in DEV and unavailable in PROD", () => {
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    expect(preflight).toContain("!isDevelopmentEnvironment()");
    expect(preflight).toContain('process.env.BIZPORTAL_GMAIL_PROFILE_VERIFY_ENABLED_DEV !== "true"');
    expect(preflight).toContain('res.status(404)');
    expect(api).toContain('connectionVerifyAvailable: isDevelopmentEnvironment()');
    expect(ui).toContain("status.connectionVerifyAvailable && (");
  });

  it("requires Finance admin authentication and explicit tenant binding before token retrieval", () => {
    expect(preflight).toContain("await requireFinanceAdmin(req)");
    expect(preflight).toContain("actor.companyId == null");
    expect(preflight).toContain('actor.role.trim().toLowerCase() !== "super_admin"');
    expect(preflight).toContain("COMPANY_SCOPE_MISSING");
    expect(preflight).toContain("requireCompanyScope(res, actor, req.body?.company_id)");
    expect(preflight).toContain('getConfig(companyId, "REFRESH_TOKEN")');
    expect(preflight).toContain('getConfig(companyId, "EMAIL")');
    expect(preflight).toContain("storedEmail.trim().toLowerCase() !== expectedEmail");
  });

  it("contacts only OAuth token and Gmail profile helpers; never imports or posts invoices", () => {
    expect(preflight).toContain("await decryptRefreshToken(encryptedToken)");
    expect(preflight).toContain("await refreshAccessToken(");
    expect(preflight).toContain("await gmailProfile(accessToken)");
    expect(preflight).not.toMatch(/\b(setConfig|syncGmailInvoiceCandidates|importGmailInvoiceCandidate|pool\.query|provisionGmailOrganizationRules)\s*\(/);
    expect(preflight).toContain('verifiedScope: "gmail_profile_only"');
    expect(preflight).toContain("inboxScanned: false");
    expect(preflight).toContain("invoiceImported: false");
    expect(preflight).not.toMatch(/router\.(get|patch|put|delete)\(/);
  });

  it("never shows 'Connected' as proof of live OAuth or successful sync", () => {
    expect(ui).toContain("Token Gmail tersimpan");
    expect(ui).toContain("Status belum tersedia");
    expect(ui).toContain("status?.connected && !status.lastSyncAt");
    expect(ui).toContain("Verifikasi Gmail (tanpa impor)");
    expect(ui).toContain("result.companyId !== companyId");
  });

  it("discards provider responses from a previous company selection", () => {
    expect(ui).toContain("profileVerifySerial.current += 1");
    expect(ui).toContain("const serial = ++profileVerifySerial.current");
    expect(ui).toContain("if (serial !== profileVerifySerial.current) return");
    expect(ui).toContain("if (serial === profileVerifySerial.current) setAction(null)");
  });
});
