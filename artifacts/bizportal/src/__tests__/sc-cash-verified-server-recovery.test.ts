import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");
const route=readFileSync(resolve(process.cwd(),"../api-server/src/routes/sc-future-cash-preview.ts"),"utf8");

describe("Account18 verified proof recovery into existing voucher OTP controls",()=>{
  it("fetches VERIFIED but unapproved documents after signed Owner readiness",()=>{
    expect(page).toContain('fetch(ENDPOINT+"/documents/verified"');
    expect(page).toContain('list?.mode!=="ACCOUNT18_VERIFIED_UNAPPROVED_SERVER_RECORDS"');
    expect(page).toContain('list.companyId!==1 || list.accountId!==18');
    expect(page).toContain('list.postingAllowed!==false');
    expect(page).toContain('setServerVerifiedDocuments(valid)');
    expect(route).toContain('router.get(PATH + "/documents/verified", cashRecoveryRateLimit');

    expect(route).toContain("ev.event_type='VERIFIED'");
    expect(route).toContain("a.metadata->>'transactionId'");
  });
  it("uses existing locked voucher OTP form without issuing OTP on recovery",()=>{
    expect(page).toContain('Dokumen VERIFIED menunggu OTP Owner');
    expect(page).toContain('Buka persetujuan OTP');
    expect(page).toContain('setPendingEvidence({transactionId:doc.transactionId,status:"PENDING_VERIFICATION"})');
    expect(page).toContain('setVerifiedId(doc.transactionId)');
    expect(page).toContain('voucherLock.current');
    expect(page).toContain('ENDPOINT+"/voucher/otp/send"');
    expect(page).toContain('ENDPOINT+"/voucher/otp/confirm"');
    expect(page).toContain('payload?.postingAllowed!==false');
    expect(page).toContain('APPROVED — persetujuan OTP tercatat di server. Jurnal belum diposting.');
  });
  it("keeps read-only discovery isolated from private evidence and ledger writes",()=>{
    const api=route.slice(route.indexOf('router.get(PATH + "/documents/verified"'),
      route.indexOf('router.post(PATH + "/preview"'));
    expect(api).toContain('postingAllowed:false');
    expect(api).not.toContain("insert into");
    expect(api).not.toContain("object_path");
    expect(api).not.toContain("code_hash");
  });
});
