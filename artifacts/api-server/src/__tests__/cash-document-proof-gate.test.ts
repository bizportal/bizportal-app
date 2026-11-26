import { describe,expect,it } from "vitest";
import { validateCashDocumentProofs, type VerifiedCashDocumentSnapshot } from "../lib/cash-document-proof-gate";
import { planEvidenceScopedCashDrafts } from "../lib/cash-evidence-draft-bridge";
const scope={companyId:1,configId:5,accountId:18,cashCoaId:75839};
const row={rowNumber:3,sourceFingerprint:"f".repeat(64),transactionDate:"2026-11-26",
  amountCents:11278,direction:"OUT" as const,counterCoaId:null};
const doc:VerifiedCashDocumentSnapshot={
  documentId:"synthetic-voucher-001",documentType:"approved_cash_document",
  companyId:1,cashAccountId:18,sourceConfigId:5,physicalRow:3,
  sourceFingerprint:row.sourceFingerprint,date:row.transactionDate,
  amountCents:11278,direction:"OUT",counterCoaId:202,
  documentStatus:"VERIFIED",verifiedBy:"test@example.invalid",
  verifiedAt:"2026-11-26T12:00:00Z",
};
const coa=[{id:202,companyId:1,isActive:true,isPostable:true,isHeader:false}];
describe("read-only primary-document-to-cash-row matching contract",()=>{
  it("keeps all 374 synthetic rows blocked when documentary evidence is absent",()=>{
    const rows=Array.from({length:374},(_,i)=>({...row,rowNumber:i+3}));
    const validated=validateCashDocumentProofs(scope,rows,[]);
    const draft=planEvidenceScopedCashDrafts(scope,rows,validated.verifiedEvidence,coa);
    expect(validated).toMatchObject({verified:0,blocked:374,reasonCounts:{MISSING_DOCUMENT:374},readyForCommit:false});
    expect(draft.draft.proposals).toHaveLength(0);
    expect(draft.readyForCommit).toBe(false);
  });
  it("produces only a draft for a structurally matched, trusted document snapshot",()=>{
    const result=validateCashDocumentProofs(scope,[row],[doc]);
    expect(result).toMatchObject({verified:1,blocked:0,readyForCommit:false});
    const draft=planEvidenceScopedCashDrafts(scope,[row],result.verifiedEvidence,coa);
    expect(draft.draft.proposals[0]?.legs).toEqual([
      {coaId:202,side:"DR",amountCents:11278},
      {coaId:75839,side:"CR",amountCents:11278},
    ]);
    expect(draft.readyForCommit).toBe(false);
  });
  it("blocks company, source, date, direction, amount and fingerprint mismatches",()=>{
    const alterations:Partial<VerifiedCashDocumentSnapshot>[]=[
      {companyId:2},{cashAccountId:17},{sourceConfigId:3},{physicalRow:4},
      {sourceFingerprint:"a".repeat(64)},{date:"2026-11-25"},
      {direction:"IN"},{amountCents:11279},{documentStatus:"DRAFT"},
      {documentStatus:"REVOKED"},{verifiedAt:null},{verifiedBy:null},
      {counterCoaId:75839},
    ];
    for(const patch of alterations) {
      const result=validateCashDocumentProofs(scope,[row],[{...doc,...patch}]);
      expect(result.verified).toBe(0);
      expect(result.readyForCommit).toBe(false);
    }
  });
  it("does not accept duplicate document identity or duplicate row candidates",()=>{
    expect(validateCashDocumentProofs(scope,[row],[doc,doc]).verified).toBe(0);
    expect(validateCashDocumentProofs(scope,[row,{...row,rowNumber:4}],[doc,{...doc,physicalRow:4}]).verified).toBe(0);
    expect(validateCashDocumentProofs(scope,[row,row],[doc]).verified).toBe(1);
  });
  it("fails closed on unauthorized cash scope",()=>{
    expect(()=>validateCashDocumentProofs({...scope,accountId:17},[row],[doc]))
      .toThrow("CASH_DOCUMENT_PROOF_SCOPE_INVALID");
  });
});
