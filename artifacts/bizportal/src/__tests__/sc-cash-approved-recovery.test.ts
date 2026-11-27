import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");
describe("Account18 approved voucher server recovery",()=>{
  const start=page.indexOf('const approvedResponse=await fetch(ENDPOINT+"/documents/approved"');
  const end=page.indexOf('setApprovedListError(true)',start);
  const recovery=page.slice(start,end);
  it("loads only authenticated server approval records after readiness",()=>{
    expect(start).toBeGreaterThan(page.indexOf('fetch(ENDPOINT+"/readiness?company_id=1"'));
    expect(recovery).toContain('credentials:"include",cache:"no-store",signal:controller.signal');
    expect(recovery).toContain('list?.mode!=="ACCOUNT18_APPROVED_SERVER_RECORDS"');
    expect(recovery).toContain('list.companyId!==1');
    expect(recovery).toContain('list.accountId!==18');
    expect(recovery).toContain('list.postingAllowed!==false');
    expect(recovery).toContain('doc?.status==="APPROVED"');
    expect(recovery).toContain('version===companyRequestVersion.current');
    expect(recovery).not.toContain('sessionStorage');
    expect(recovery).not.toContain('method:"POST"');
  });
  it("excludes approved UUIDs from pending and verified lists and OTP form",()=>{
    expect(recovery).toContain('setServerVerifiedDocuments(old=>old.filter(doc=>!ids.has(doc.transactionId)))');
    expect(recovery).toContain('setServerPendingDocuments(old=>old.filter(doc=>!ids.has(doc.transactionId)))');
    expect(page).toContain('!serverApprovedDocuments.some(doc=>doc.transactionId===pendingEvidence.transactionId)');
    expect(page).toContain('serverApprovedDocuments.map(doc=>');
    expect(page).toContain('setServerApprovedDocuments([]);setServerRevokedDocuments([]);setApprovedListError(false)');
    expect(page).not.toContain('"/journal/post"');
  });
});
