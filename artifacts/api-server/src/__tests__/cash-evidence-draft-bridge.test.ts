import { describe, expect, it } from "vitest";
import { planEvidenceScopedCashDrafts } from "../lib/cash-evidence-draft-bridge";
import type { CounterCoaEvidence } from "../lib/cash-counter-coa-evidence";
const scope = { companyId:1,configId:5,accountId:18,cashCoaId:75839 };
const cashRow = {rowNumber:3,transactionDate:"2026-11-26",
  direction:"IN" as const,amountCents:11278,sourceFingerprint:"a".repeat(64),
  counterCoaId:null };
const coas = [{id:101,companyId:1,isActive:true,isPostable:true,isHeader:false}];
const proof: CounterCoaEvidence = {rowNumber:3,sourceFingerprint:cashRow.sourceFingerprint,
  counterCoaId:101,verifiedSourceType:"journal",verifiedSourceId:"TEST-journal-001",
  verifiedBy:"qa@example.com"};
describe("evidence-gated cash draft integration, no writes", () => {
  it("blocks all 374 synthetic source rows without counterparty evidence", () => {
    const rows = Array.from({length:374},(_,i) => ({...cashRow,rowNumber:i+3}));
    const result = planEvidenceScopedCashDrafts(scope,rows,[],coas);
    expect(result.evidence).toMatchObject({eligibleRows:0,blockedRows:374,
      reasonCounts:{EVIDENCE_MISSING:374}});
    expect(result.draft.proposals).toHaveLength(0);
    expect(result.draft.blocked).toHaveLength(374);
    expect(result.readyForCommit).toBe(false);
  });
  it("uses separately verified evidence for draft-only two-sided journal", () => {
    const result=planEvidenceScopedCashDrafts(scope,[cashRow],[proof],coas);
    expect(result.evidence.eligibleRows).toBe(1);
    expect(result.draft.proposals).toHaveLength(1);
    expect(result.draft.proposals[0]?.legs).toEqual([
      {coaId:75839,side:"DR",amountCents:11278},
      {coaId:101,side:"CR",amountCents:11278},
    ]);
    expect(result.readyForCommit).toBe(false);
  });
  it("does not trust an unverified counter account passed on a source row", () => {
    const injected = {...cashRow,counterCoaId:101};
    const result=planEvidenceScopedCashDrafts(scope,[injected],[],coas);
    expect(result.draft.proposals).toHaveLength(0);
    expect(result.draft.blocked).toHaveLength(1);
  });
  it("replay is idempotent, changed mapping gets new draft fingerprint", () => {
    const first=planEvidenceScopedCashDrafts(scope,[cashRow],[proof],coas);
    const original=first.draft.proposals[0]!;
    const replay=planEvidenceScopedCashDrafts(scope,[cashRow],[proof],coas,
      new Map([[original.sourceKey,original.fingerprint]]));
    expect(replay.draft).toMatchObject({newRows:0,replayedRows:1,changedRows:0});
    const differentCoa=[...coas,{id:202,companyId:1,isActive:true,isPostable:true,isHeader:false}];
    const altered=planEvidenceScopedCashDrafts(scope,[cashRow],
      [{...proof,counterCoaId:202}],differentCoa,
      new Map([[original.sourceKey,original.fingerprint]]));
    expect(altered.draft).toMatchObject({newRows:0,replayedRows:0,changedRows:1,readyForCommit:false});
  });
  it("rejects invalid foreign COAs and proof duplication", () => {
    const foreign=planEvidenceScopedCashDrafts(scope,[cashRow],[proof],
      [{...coas[0]!,companyId:2}]);
    expect(foreign.evidence.reasonCounts.COA_WRONG_COMPANY).toBe(1);
    expect(foreign.draft.proposals).toHaveLength(0);
    const duplicated=planEvidenceScopedCashDrafts(scope,[cashRow],[proof,proof],coas);
    expect(duplicated.evidence.reasonCounts.UNVERIFIED_EVIDENCE).toBe(1);
  });
  it("does not leak proof metadata in summary", () => {
    const result=planEvidenceScopedCashDrafts(scope,[cashRow],[proof],coas);
    expect(JSON.stringify(result.evidence)).not.toContain(proof.verifiedSourceId);
    expect(JSON.stringify(result.evidence)).not.toContain(proof.verifiedBy);
  });
});
