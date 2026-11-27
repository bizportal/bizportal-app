import { describe, expect, it } from "vitest";
import { cashAmountToCents, parseCashEvidenceReview, matchingCashEvidenceReview } from "../lib/future-cash-content-review";

const id="25088529-6fa1-4ddb-80bf-390c157e64d4";
const source={transactionId:id,documentSha256:"a".repeat(64),sourceFingerprint:"b".repeat(64),
  date:"2026-11-27",amountCents:"1000000"};
const valid={evidenceKind:"BANK_TRANSFER_RECEIPT",evidenceDate:"2026-11-27",
  evidenceAmount:"10000.00",reference:"BANK-REF-20261127-7",counterCoaId:49098,attested:true};

describe("CST-DEV Owner cash evidence is not the same as PDF byte integrity",()=>{
  it("requires exact cents, amount and source date",()=>{
    expect(cashAmountToCents("10000.00")).toBe("1000000");
    expect(cashAmountToCents("10000")).toBe("1000000");
    for(const bad of ["-10000","10000.999","0010000","Infinity","0","1e6"])
      expect(cashAmountToCents(bad)).toBeNull();
    expect(parseCashEvidenceReview(valid,source)?.evidenceAmountCents).toBe("1000000");
    expect(parseCashEvidenceReview({...valid,evidenceAmount:"10001"},source)).toBeNull();
    expect(parseCashEvidenceReview({...valid,evidenceDate:"2026-11-26"},source)).toBeNull();
  });
  it("rejects NPWP, KTP and arbitrary files as financial receipts",()=>{
    for(const kind of ["IDENTITY_DOCUMENT","NPWP","KTP","OTHER","TAX_CARD",""]){
      expect(parseCashEvidenceReview({...valid,evidenceKind:kind},source)).toBeNull();
    }
    expect(parseCashEvidenceReview({...valid,reference:"NPWP-20261127"},source)).toBeNull();
    expect(parseCashEvidenceReview({...valid,reference:"NoRef"},source)).toBeNull();
    expect(parseCashEvidenceReview({...valid,attested:false},source)).toBeNull();
  });
  it("reuses only one attestation bound to hash, fingerprint, date, amount and COA",()=>{
    const reviewed=parseCashEvidenceReview(valid,source);
    expect(reviewed).not.toBeNull();
    const metadata={...source,...reviewed};
    expect(matchingCashEvidenceReview(metadata,source,49098)).toBe(true);
    expect(matchingCashEvidenceReview(metadata,source,75594)).toBe(false);
    expect(matchingCashEvidenceReview(metadata,{...source,documentSha256:"c".repeat(64)},49098)).toBe(false);
    expect(matchingCashEvidenceReview(metadata,{...source,amountCents:"1000001"},49098)).toBe(false);
    expect(matchingCashEvidenceReview(metadata,{...source,sourceFingerprint:"d".repeat(64)},49098)).toBe(false);
  });
});
