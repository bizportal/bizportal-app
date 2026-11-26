import { describe, expect, it } from "vitest";
import { prepareFutureCashVoucherJournal, type FutureCashVoucher } from "../lib/cash-future-voucher";
import { prepareCashJournal } from "../lib/cash-ledger-posting";

const scope = { companyId:1, accountId:18, cashCoaId:75839, counterpartyCoaId:902 };
const voucher: FutureCashVoucher = {
  voucherId:"11111111-1111-4111-8111-111111111111",
  date:"2026-11-27", direction:"IN", amount:"150000.25",
  documentSha256:"a".repeat(64), approvalSha256:"b".repeat(64),
};

describe("future Account18 voucher identity (pure; no business DB writer)", () => {
  it("uses voucher UUID identity unrelated to Config5 physical Sheet row", () => {
    const future=prepareFutureCashVoucherJournal(scope,voucher);
    const old=prepareCashJournal({ ...scope, accountType:"cash", configId:5 },
      {rowNumber:3,date:voucher.date,direction:voucher.direction,
        amount:voucher.amount,sourceFingerprint:"c".repeat(64)});
    expect(future.sourceKey).toMatch(/^[a-f0-9]{64}$/);
    expect(future.sourceKey).not.toBe(old.sourceKey);
    expect(prepareFutureCashVoucherJournal(scope,voucher)).toEqual(future);
    expect(prepareFutureCashVoucherJournal(scope,{...voucher,
      voucherId:"22222222-2222-4222-8222-222222222222"}).sourceKey).not.toBe(future.sourceKey);
  });
  it("preserves exact cents and a two-COA balanced journal", () => {
    const r=prepareFutureCashVoucherJournal(scope,voucher);
    expect(r.amountCents).toBe(15000025n);
    expect(r.lines).toEqual([
      {accountId:75839,debitCents:15000025n,creditCents:0n},
      {accountId:902,debitCents:0n,creditCents:15000025n},
    ]);
    const out=prepareFutureCashVoucherJournal(scope,{...voucher,direction:"OUT"});
    expect(out.lines[0].creditCents).toBe(15000025n);
    expect(out.lines[1].debitCents).toBe(15000025n);
  });
  it("same voucher ID with altered document, approval, amount, counter COA changes fingerprint", () => {
    const r=prepareFutureCashVoucherJournal(scope,voucher);
    const variants=[
      {scope,voucher:{...voucher,documentSha256:"c".repeat(64)}},
      {scope,voucher:{...voucher,approvalSha256:"d".repeat(64)}},
      {scope,voucher:{...voucher,amount:"150000.26"}},
      {scope:{...scope,counterpartyCoaId:903},voucher},
    ];
    for(const v of variants){
      const changed=prepareFutureCashVoucherJournal(v.scope,v.voucher);
      expect(changed.sourceKey).toBe(r.sourceKey);
      expect(changed.fingerprint).not.toBe(r.fingerprint);
    }
  });
  it("rejects wrong company, old cash COA and any other account",()=>{
    expect(()=>prepareFutureCashVoucherJournal({...scope,companyId:3},voucher))
      .toThrow("FUTURE_CASH_CST_ACCOUNT18_ONLY");
    expect(()=>prepareFutureCashVoucherJournal({...scope,cashCoaId:49097},voucher))
      .toThrow("FUTURE_CASH_CST_ACCOUNT18_ONLY");
    expect(()=>prepareFutureCashVoucherJournal({...scope,accountId:1},voucher))
      .toThrow("FUTURE_CASH_CST_ACCOUNT18_ONLY");
  });
  it("rejects missing voucher/doc/approval fingerprint and invalid date",()=>{
    expect(()=>prepareFutureCashVoucherJournal(scope,{...voucher,voucherId:"sheet-row-262"}))
      .toThrow("FUTURE_CASH_VOUCHER_ID_REQUIRED");
    expect(()=>prepareFutureCashVoucherJournal(scope,{...voucher,documentSha256:""}))
      .toThrow("FUTURE_CASH_AUTHENTICATED_EVIDENCE_REQUIRED");
    expect(()=>prepareFutureCashVoucherJournal(scope,{...voucher,approvalSha256:""}))
      .toThrow("FUTURE_CASH_AUTHENTICATED_EVIDENCE_REQUIRED");
    expect(()=>prepareFutureCashVoucherJournal(scope,{...voucher,date:"2026-02-30"}))
      .toThrow("INVALID_CASH_DATE");
    expect(()=>prepareFutureCashVoucherJournal(scope,{...voucher,amount:"0"}))
      .toThrow("INVALID_CASH_AMOUNT");
  });
});
