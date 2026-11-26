import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(process.cwd(), "src/pages/sales/document-detail.tsx"), "utf8");
const salesRouter = readFileSync(resolve(process.cwd(), "../api-server/src/routes/sales-core.ts"), "utf8");

describe("CST-DEV QA #108 Invoice button must not bypass canonical posting owner", () => {
  it("uses the exact DEV host and document identity gate", () => {
    expect(page).toContain('window.location.hostname === "dev-bizportal.cstlogistic.co.id" && docId === 108');
  });
  it("does not invoke the legacy mark_invoiced action on QA #108", () => {
    expect(page).toContain('if (action === "mark_invoiced" && canShowQa108) {');
    expect(page).toContain('disabled={actionLoading === "mark_invoiced" || canShowQa108}');
    expect(page).toContain('Invoice QA menunggu PostingEngine');
  });
  it("preserves the existing signed OTP confirmation route and refuses unsupported invoice action", () => {
    expect(salesRouter).toContain('request.body?.action !== "confirm"');
    expect(salesRouter).toContain('Only Sales confirmation is supported');
    expect(salesRouter).toContain('getProductionSession(request)');
  });
});
