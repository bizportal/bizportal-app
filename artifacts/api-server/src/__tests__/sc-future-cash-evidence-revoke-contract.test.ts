import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";
const route=readFileSync(resolve(process.cwd(),"src/routes/sc-future-cash-preview.ts"),"utf8");

describe("Account18 signed Owner evidence revoke and recovery contract",()=>{
  it("restricts approval to signed DEV Owner and exact documented evidence review",()=>{
    const send=route.slice(route.indexOf('router.post(PATH + "/voucher/otp/send"'),
      route.indexOf('router.post(PATH + "/voucher/otp/confirm"'));
    const confirm=route.slice(route.indexOf('router.post(PATH + "/voucher/otp/confirm"'));
    expect(route).toContain('process.env.APP_ENV !== "development"');
    expect(route).toContain('getProductionSession(req)');
    expect(route).toContain('["owner", "super_admin"].includes');
    expect(route).toContain('router.post(PATH + "/documents/review"');
    expect(send).toContain("matchingCashEvidenceReview(");
    expect(confirm).toContain("matchingCashEvidenceReview(");
    expect(send).toContain("SC_CASH_OWNER_CONTENT_REVIEW_REQUIRED");
    expect(confirm).toContain("SC_CASH_OWNER_CONTENT_REVIEW_REQUIRED");
    expect(route).toContain("sourceFingerprint:d.source_fingerprint");
    expect(route).toContain("documentSha256:d.document_sha256");
    expect(route).toContain("counterCoaId:reviewed.counterCoaId");
  });
  it("requires explicit, serializable REVOKED event and compensating audit, preserves old approvals",()=>{
    const revoke=route.slice(route.indexOf('router.post(PATH + "/documents/revoke"'),
      route.indexOf('router.get(PATH + "/documents/revoked"'));
    expect(revoke).toContain('req.get("origin")!==OWNER_ORIGIN');
    expect(revoke).toContain('for update');
    expect(revoke).toContain('event_type==="REVOKED"');
    expect(revoke).toContain('on conflict (transaction_id,event_type) do nothing');
    expect(revoke).toContain("'sc_future_cash_evidence_revocation'");
    expect(revoke).toContain("priorApprovalId");
    expect(revoke).toContain('res.status(200).json({transactionId:id,status:"REVOKED",alreadyRevoked:true');
    expect(revoke).toContain("SC_CASH_JOURNAL_REVERSAL_REQUIRED");
    expect(revoke).not.toContain("delete from public.approval_requests");
    expect(revoke).not.toContain("update public.approval_requests");
    expect(revoke).not.toContain("insert into public.accounting_entries");
    expect(route).toContain('router.get(PATH + "/documents/approved"');
    expect(route).toContain('router.get(PATH + "/documents/revoked"');
  });
});
