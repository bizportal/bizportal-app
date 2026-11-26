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
    expect(page).toContain('<Select value={direction} disabled={evidenceBusy}');
    expect(page).toContain('<DatePicker value={date} disabled={evidenceBusy}');
    expect(page).toContain('disabled={evidenceBusy} onChange={e=>{if(evidenceBusy)return;setAmount');
    expect(page).toContain('<Select value={counterCoaId} disabled={evidenceBusy}');
    expect(page).toContain('disabled={busy || evidenceBusy || loading');
    expect(page).toContain('if(activeCompanyId!==1 || !readiness || busy || evidenceBusy) return;');
  });
  it("keeps returned transaction UUID when only preview version changes", () => {
    expect(page).toContain('if(version!==companyRequestVersion.current)return;');
    expect(page).toContain('setPendingEvidence({transactionId:payload.transactionId,status:"PENDING_VERIFICATION"})');
    expect(page).toContain('postingAllowed?:boolean');
    expect(page).not.toContain('readyForCommit:true');
  });
});
