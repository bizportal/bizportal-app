import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");

describe("Account18 Owner pending integrity button, no posting",()=>{
  it("only calls the authenticated read-only audit for a pending UUID",()=>{
    expect(page).toContain('const checkPendingIntegrity=async()=>{');
    expect(page).toContain('!readiness || !pendingEvidence || integrityBusy || evidenceBusy');
    expect(page).toContain('"/documents/"+encodeURIComponent(id)+"/integrity"');
    expect(page).toContain('method:"GET",credentials:"include",cache:"no-store"');
    expect(page).toContain('onClick={()=>void checkPendingIntegrity()}');
  });
  it("only displays PASS on exact backend response, never client session value",()=>{
    for(const check of [
      'payload?.transactionId===id','payload.status==="PENDING_VERIFICATION"',
      'payload.storageIntegrity==="MATCH"','payload.documentApproval==="NOT_VERIFIED"',
      'payload.postingAllowed===false','payload.historicalSheetConfig5==="NOT_USED_NONMIGRATION"',
    ]) expect(page).toContain(check);
    expect(page).toContain('setIntegrityResult("UNAVAILABLE")');
  });
  it("keeps integrity check separate from VERIFIED approval or journal posting",()=>{
    expect(page).toContain('Periksa integritas PDF (baca-saja)');
    expect(page).toContain('Dokumen tetap');
    expect(page).toContain('PENDING_VERIFICATION; persetujuan dan posting belum diaktifkan.');
    expect(page).not.toContain('"/documents/verify"');
    expect(page).not.toContain('"/journal/post"');
    expect(page).not.toContain('storageIntegrity:"MATCH"');
  });
});
