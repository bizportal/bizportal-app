import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";

const ui=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");
describe("Recovered Account18 original proof explicit Owner review",()=>{
  it("provides manual review for recovered UUID without reupload",()=>{
    expect(ui).toContain('Dokumen dipulihkan dari server. Unduh bukti asli untuk diperiksa');
    expect(ui).toContain('Unduh bukti asli untuk diperiksa (Owner)');
    expect(ui).toContain('setReviewedUpload(null);setVerifiedId(null)');
    expect(ui).toContain('setOwnerReviewConfirmed(false)');
    expect(ui).toContain('checked={ownerReviewConfirmed}');
    expect(ui).toContain('onChange={e=>setOwnerReviewConfirmed(e.target.checked)}');
    expect(ui).toContain('integrityResult!=="MATCH"||!ownerReviewConfirmed');
  });
  it("requires fresh integrity PASS and explicit confirmation before VERIFIED event",()=>{
    const review=ui.slice(ui.indexOf('const verifyEvidence=async()=>{'),
      ui.indexOf('  return (\n    <div'));
    expect(review).toContain('integrityResult!=="MATCH" || !ownerReviewConfirmed');
    expect(review).toContain('window.confirm(');
    expect(review).toContain('method:"POST",credentials:"include",cache:"no-store"');
    expect(review).toContain('confirmed:true');
    expect(review).toContain('payload?.postingAllowed!==false');
    expect(review).not.toContain('"/journal/post"');
  });
  it("resets review confirmation after switching company or re-checking bytes",()=>{
    expect(ui).toContain('setIntegrityBusy(true);\n    setIntegrityResult(null);\n    setOwnerReviewConfirmed(false);');
    expect(ui).toContain('setVerifiedId(id);setIntegrityResult(null);setOwnerReviewConfirmed(false);');
  });
});
