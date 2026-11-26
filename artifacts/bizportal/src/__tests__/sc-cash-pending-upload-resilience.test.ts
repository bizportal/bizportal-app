import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(process.cwd(), "src/pages/cash-bank/sc-new.tsx"), "utf8");
const route = readFileSync(resolve(process.cwd(), "../api-server/src/routes/sc-future-cash-preview.ts"), "utf8");

describe("Kas Besar SC pending evidence upload resilience", () => {
  it("accepts the six valid multipart fields/file without reaching parts ceiling", () => {
    expect(route).toMatch(/files:\s*1,\s*fields:\s*5,\s*parts:\s*7/);
    expect(route).toContain('SC_CASH_DOCUMENT_UPLOAD_INVALID');
  });
  it("locks all draft changes while evidence upload is in flight", () => {
    expect(page).toContain('<Select value={direction} disabled={evidenceBusy||!!pendingEvidence}');
    expect(page).toContain('<DatePicker value={date} disabled={evidenceBusy||!!pendingEvidence}');
    expect(page).toContain('disabled={evidenceBusy||!!pendingEvidence} onChange={e=>{if(evidenceBusy||pendingEvidence)return;setAmount');
    expect(page).toContain('<Select value={counterCoaId} disabled={evidenceBusy||!!pendingEvidence}');
    expect(page).toContain('disabled={busy || evidenceBusy || !!pendingEvidence || loading');
    expect(page).toContain('if(activeCompanyId!==1 || !readiness || busy || evidenceBusy || !!pendingEvidence) return;');
  });
  it("preserves server receipt across CompanySwitcher changes and disabled sessionStorage", () => {
    const uploadFn=page.slice(page.indexOf("const uploadPendingEvidence=async()=>"),
      page.indexOf("  return (\n    <div className=\"space-y-5\">"));
    expect(uploadFn).not.toContain("if(version!==companyRequestVersion.current)return;");
    expect(uploadFn).toContain("sessionStorage.setItem(COMPANY1_PENDING_ACK_KEY");
    expect(uploadFn).toContain("setPendingEvidence(ack)");
    expect(page).toContain("sessionStorage.getItem(COMPANY1_PENDING_ACK_KEY)");
    expect(page).toContain("{readiness && pendingEvidence && activeCompanyId===1 && (");
    expect(page).toContain("sessionStorage.removeItem(COMPANY1_PENDING_ACK_KEY)");
    expect(page).toContain("Buat transaksi baru");
    expect(page).not.toContain("readyForCommit:true");
  });
});
