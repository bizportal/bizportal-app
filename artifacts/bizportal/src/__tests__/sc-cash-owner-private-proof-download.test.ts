import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");
const route=readFileSync(resolve(process.cwd(),"../api-server/src/routes/sc-future-cash-preview.ts"),"utf8");

describe("Account18 Owner private proof download, no posting",()=>{
  it("links only the current restored pending UUID to authenticated server download",()=>{
    expect(page).toContain('href={ENDPOINT+"/documents/"+encodeURIComponent(pendingEvidence.transactionId)+"/download"}');
    expect(page).toContain('Unduh bukti asli untuk diperiksa (Owner)');
    expect(page).toContain('dokumen secara manual sebelum memverifikasi');
    expect(page).toContain('readiness && pendingEvidence && activeCompanyId===1');
  });
  it("server enforces attachment-only private bytes, no public URL or posting",()=>{
    const start=route.indexOf('router.get(PATH + "/documents/:transactionId/download"');
    const end=route.indexOf("/** Explicit Owner review",start);
    const code=route.slice(start,end);
    expect(start).toBeGreaterThan(0);
    expect(code).toContain("readPendingFutureCashVerifiedBytes(id,pool,pendingEvidenceStorage,true)");
    expect(code).toContain('Content-Disposition');
    expect(code).toContain('attachment; filename=');
    expect(code).toContain('no-store');
    expect(code).toContain('nosniff');
    expect(code).not.toContain('insert into');
    expect(code).not.toContain('postingAllowed:true');
  });
});
