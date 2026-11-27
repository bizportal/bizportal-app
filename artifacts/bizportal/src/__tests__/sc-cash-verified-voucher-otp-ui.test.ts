import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");
const route=readFileSync(resolve(process.cwd(),"../api-server/src/routes/sc-future-cash-preview.ts"),"utf8");

describe("Account18 verified voucher OTP Owner workflow, no posting",()=>{
  it("discovers only VERIFIED and unapproved server documents after signed readiness",()=>{
    expect(page).toContain('fetch(ENDPOINT+"/documents/verified"');
    expect(page).toContain('data?.mode!=="ACCOUNT18_VERIFIED_UNAPPROVED_SERVER_RECORDS"');
    expect(page).toContain('data.companyId!==1 || data.accountId!==18');
    expect(page).toContain('data.postingAllowed!==false');
    expect(page).toContain('setServerVerifiedDocuments(verified)');
    expect(route).toContain('ev.event_type=\'VERIFIED\'');
    expect(route).toContain("a.metadata->>'transactionId'");
    expect(route).toContain("limit 20");
  });
  it("requires Owner selection of voucher and eligible counter-COA before issuing scoped OTP",()=>{
    expect(page).toContain('Pilih untuk OTP voucher');
    expect(page).toContain('Pilih COA lawan sesuai bukti');
    expect(page).toContain('const sendVoucherOtp=async()=>');
    expect(page).toContain('readiness.contraCandidates.find(c=>String(c.id)===voucherContraCoaId)');
    expect(page).toContain('ENDPOINT+"/voucher/otp/send"');
    expect(page).toContain('method:"POST",credentials:"include",cache:"no-store"');
    expect(page).toContain('data.status!=="OTP_SENT"');
    expect(page).toContain('data.postingAllowed!==false');
    expect(page).toContain('window.confirm(');
  });
  it("consumes six-digit voucher OTP on explicit Owner action without posting",()=>{
    expect(page).toContain('Kode OTP khusus voucher (6 digit)');
    expect(page).toContain('const confirmVoucherOtp=async()=>');
    expect(page).toContain('ENDPOINT+"/voucher/otp/confirm"');
    expect(page).toContain('data.status!=="APPROVED"');
    expect(page).toContain('data.postingAllowed!==false');
    expect(page).toContain('setVoucherApprovedId(id)');
    expect(page).toContain('setVoucherCode("")');
    expect(page).toContain('Posting jurnal tetap NONAKTIF');
    const section=page.slice(page.indexOf('const sendVoucherOtp=async()=>'),
      page.indexOf('  return (\n    <div'));
    expect(section).not.toContain('"/journal/post"');
    expect(section).not.toContain("postingAllowed:true");
  });
});
