import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");
describe("Account18 Owner voucher OTP UI — no posting",()=>{
  const send=page.slice(page.indexOf("const requestVoucherOtp=async()=>{"),page.indexOf("const confirmVoucherOtp=async()=>{"));
  const confirm=page.slice(page.indexOf("const confirmVoucherOtp=async()=>{"),page.indexOf("  return (\n    <div"));
  it("issues only for signed readiness and verified document, with explicit COA",()=>{
    expect(send).toContain("verifiedId!==pendingEvidence.transactionId");
    expect(send).toContain("window.confirm(");
    expect(send).toContain('"/voucher/otp/send"');
    expect(send).toContain("counterCoaId:coa.id");
    expect(send).toContain('payload?.status!=="OTP_SENT"');
    expect(send).toContain("payload?.postingAllowed!==false");
  });
  it("binds confirmation to same challenge and validates exact server acknowledgement",()=>{
    expect(confirm).toContain("voucherChallenge.transactionId!==verifiedId");
    expect(confirm).toContain("String(voucherChallenge.counterCoaId)!==voucherCoa");
    expect(confirm).toContain('"/voucher/otp/confirm"');
    expect(confirm).toContain("code:voucherCode");
    expect(confirm).toContain('payload?.status!=="APPROVED"');
    expect(confirm).toContain("payload?.postingAllowed!==false");
    expect(confirm).toContain('finally{setVoucherCode("")');
    expect(page).toContain("disabled={voucherBusy||!!voucherChallenge}");
    expect(page).not.toContain('"/journal/post"');
  });
});
