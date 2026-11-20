import { describe,expect,it } from "vitest";
import {evaluateMarketplacePaymentRelease,type FinancialEvidence,type VerifiedActor} from "./marketplacePaymentReleaseGate";

const actor:VerifiedActor={source:"signed_server_session",role:"super_admin",email:"owner@qa.invalid",companyId:1};
const evidence=():FinancialEvidence=>({
 ap:{id:88,companyId:1,supplierId:5,invoiceId:77,status:"waiting_payment"},
 invoice:{id:77,companyId:1,supplierId:5,status:"ready_for_ap",matched:true},
 handoff:{id:9,apId:88,invoiceId:77,companyId:1,requestId:41,status:"accepted",
  accountingStatus:"draft_not_posted",payloadFingerprint:"a".repeat(64)},
 request:{id:41,apId:88,companyId:1,supplierId:5,sourceType:"marketplace_ap",sourceId:88,
  status:"approved",amount:"100.00",paidAmount:"0.00",fingerprint:"a".repeat(64),
  approvedBy:"owner@qa.invalid",approvedAt:"2026-11-20",treasuryReadyAt:"2026-11-20",
  journalEntryId:null,idempotencyKey:"mkt-ap:88"},
 bank:{id:101,companyId:1,direction:"OUT",amount:"100.00",
  status:"approved_pending_posting",bankAccountId:"BANK-1",journalEntryId:201},
 mapping:{companyId:1,bankAccountId:"BANK-1",bankCoaId:301,
  coaActive:true,coaPostable:true,bankAccountActive:true},
 journal:{id:201,companyId:1,mutationId:101,status:"draft",headerDebit:"100.00",headerCredit:"100.00",
  lines:[{companyId:1,accountId:302,debit:"100.00",credit:"0.00"},
    {companyId:1,accountId:301,debit:"0.00",credit:"100.00"}]},
 reconciliation:{companyId:1,bankMutationId:101,invoiceId:77,
  finalized:false,activeDuplicates:0,allocationAmount:"100.00"},
});
describe("CST DEV Marketplace AP payment release preflight (no writes)",()=>{
 it("accepts complete signed evidence as a CANDIDATE only, never posts",()=>{
  expect(evaluateMarketplacePaymentRelease(actor,evidence())).toEqual({status:"GO_CANDIDATE",blockers:[]});
 });
 const cases:Array<[string,(e:FinancialEvidence)=>void,string]>=[
  ["company isolation",e=>{e.bank.companyId=3},"COMPANY_SCOPE_MISMATCH"],
  ["other company journal line",e=>{e.journal.lines[0]!.companyId=3},"COMPANY_SCOPE_MISMATCH"],
  ["duplicate payment request linkage",e=>{e.request.sourceId=99},"LINKAGE_MISMATCH"],
  ["tampered immutable fingerprint",e=>{e.request.fingerprint="b".repeat(64)},"LINKAGE_MISMATCH"],
  ["invalid AP state",e=>{e.ap.status="finance_review"},"AP_NOT_APPROVED_FOR_HANDOFF"],
  ["missing owner approval",e=>{e.request.approvedAt=null},"OWNER_APPROVAL_REQUIRED"],
  ["wrong approver",e=>{e.request.approvedBy="other@qa.invalid"},"OWNER_APPROVAL_REQUIRED"],
  ["treasury not ready",e=>{e.request.treasuryReadyAt=null},"TREASURY_NOT_READY"],
  ["prior payment",e=>{e.request.paidAmount="100.00"},"PREVIOUS_PAYMENT_OR_POSTING"],
  ["previous journal",e=>{e.request.journalEntryId=201},"PREVIOUS_PAYMENT_OR_POSTING"],
  ["amount mismatch",e=>{e.bank.amount="99.99"},"INVALID_OR_MISMATCHED_AMOUNT"],
  ["invalid currency precision",e=>{e.request.amount="100.001"},"INVALID_OR_MISMATCHED_AMOUNT"],
  ["wrong direction",e=>{e.bank.direction="IN"},"BANK_SOURCE_UNVERIFIED"],
  ["wrong account",e=>{e.mapping.bankAccountId="OTHER"},"BANK_SOURCE_UNVERIFIED"],
  ["inactive COA",e=>{e.mapping.coaActive=false},"BANK_SOURCE_UNVERIFIED"],
  ["non-postable COA",e=>{e.mapping.coaPostable=false},"BANK_SOURCE_UNVERIFIED"],
  ["wrong journal reference",e=>{e.bank.journalEntryId=999},"CANONICAL_JOURNAL_MISMATCH"],
  ["unbalanced debit",e=>{e.journal.lines[0]!.debit="99.00"},"JOURNAL_UNBALANCED"],
  ["duplicate final match",e=>{e.reconciliation.activeDuplicates=1},"RECONCILIATION_NOT_READY"],
  ["already finalized",e=>{e.reconciliation.finalized=true},"RECONCILIATION_NOT_READY"],
 ];
 for(const [label,change,code] of cases) it("blocks "+label,()=>{
  const e=evidence();change(e);
  const actual=evaluateMarketplacePaymentRelease(actor,e);
  expect(actual.status).toBe("NO_GO");expect(actual.blockers).toContain(code);
 });
 it("rejects the exact currently delivered AP handoff draft state",()=>{
  const e=evidence();
  e.request.status="draft";e.request.approvedBy=null;e.request.approvedAt=null;
  e.request.treasuryReadyAt=null;
  const actual=evaluateMarketplacePaymentRelease(actor,e);
  expect(actual.status).toBe("NO_GO");
  expect(actual.blockers).toEqual(expect.arrayContaining(["OWNER_APPROVAL_REQUIRED","TREASURY_NOT_READY"]));
 });
 it("rejects missing server-verified Super Admin, even with valid financial rows",()=>{
  expect(evaluateMarketplacePaymentRelease(null,evidence()).status).toBe("NO_GO");
 });
 it("allows globally authorized owner only when the company selection is explicit",()=>{
  const global={...actor,companyId:null,approvedGlobalCompanyId:1};
  expect(evaluateMarketplacePaymentRelease(global,evidence()).status).toBe("GO_CANDIDATE");
  expect(evaluateMarketplacePaymentRelease({...global,approvedGlobalCompanyId:3},evidence()).status).toBe("NO_GO");
 });
});
