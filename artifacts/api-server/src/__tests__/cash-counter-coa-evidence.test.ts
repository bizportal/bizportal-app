import { describe, it, expect } from "vitest";
import { assessCashCounterCoaEvidence, type CounterCoaEvidence } from "../lib/cash-counter-coa-evidence";
const scope = { companyId:1, configId:5, accountId:18, cashCoaId:75839 };
const sources = [{rowNumber:3, sourceFingerprint:"a".repeat(64)}];
const coa = [{id:101,companyId:1,isActive:true,isPostable:true,isHeader:false}];
const proof: CounterCoaEvidence = {rowNumber:3,sourceFingerprint:"a".repeat(64),
 counterCoaId:101, verifiedSourceType:"journal",verifiedSourceId:"journal-123",verifiedBy:"owner@cst.example"};
describe("cash counter-COA evidence gate, read-only", () => {
 it("refuses to guess any mapping for 374 synthetic cash rows", () => {
  const rows=Array.from({length:374},(_,i)=>({rowNumber:i+3,sourceFingerprint:"a".repeat(64)}));
  const result=assessCashCounterCoaEvidence(scope,rows,[],coa);
  expect(result).toMatchObject({verified:0,blocked:374,readyForCommit:false});
  expect(result.decisions.every(x=>x.counterCoaId===null)).toBe(true);
 });
 it("accepts only explicit proof and company-scoped active postable COA", () => {
  expect(assessCashCounterCoaEvidence(scope,sources,[proof],coa)).toMatchObject({
    verified:1,blocked:0,readyForCommit:false,
    decisions:[{code:"EVIDENCE_VALID",counterCoaId:101}]});
 });
 it("fails closed on edited source, unsupported proof and duplicate evidence", () => {
  for(const p of [{...proof,sourceFingerprint:"b".repeat(64)},
      {...proof,verifiedSourceType:"narrative" as "journal"},
      {...proof,verifiedSourceId:""}]){
    expect(assessCashCounterCoaEvidence(scope,sources,[p],coa).verified).toBe(0);
  }
  expect(assessCashCounterCoaEvidence(scope,sources,[proof,proof],coa).blocked).toBe(1);
 });
 it("rejects foreign, header, inactive and same-side COAs", () => {
  expect(assessCashCounterCoaEvidence(scope,sources,[proof],[{...coa[0]!,companyId:2}]).verified).toBe(0);
  expect(assessCashCounterCoaEvidence(scope,sources,[proof],[{...coa[0]!,isHeader:true}]).verified).toBe(0);
  expect(assessCashCounterCoaEvidence(scope,sources,[proof],[{...coa[0]!,isActive:false}]).verified).toBe(0);
  expect(assessCashCounterCoaEvidence(scope,sources,[{...proof,counterCoaId:75839}],coa).verified).toBe(0);
 });
 it("rejects unauthorized account scope, malformed row and repeated physical row", () => {
  expect(()=>assessCashCounterCoaEvidence({...scope,accountId:17},sources,[proof],coa))
    .toThrow("CASH_COUNTER_COA_SCOPE_NOT_AUTHORIZED");
  expect(assessCashCounterCoaEvidence(scope,[...sources,...sources],[proof],coa).blocked).toBe(1);
  expect(assessCashCounterCoaEvidence(scope,[{rowNumber:0,sourceFingerprint:"a".repeat(64)}],[],coa).blocked).toBe(1);
 });
});
