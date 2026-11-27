import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe,expect,it} from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");
const api=readFileSync(resolve(process.cwd(),"../api-server/src/routes/sc-future-cash-preview.ts"),"utf8");

describe("Account18 pending receipt server recovery",()=>{
  it("requests server-only pending documents under signed Owner readiness",()=>{
    expect(page).toContain('fetch(ENDPOINT+"/documents/pending"');
    expect(page).toContain('credentials:"include",cache:"no-store",signal:controller.signal');
    expect(page).toContain('records?.mode!=="ACCOUNT18_PENDING_SERVER_RECORDS"');
    expect(page).toContain('records.companyId!==1 || records.accountId!==18');
    expect(page).toContain('records.postingAllowed!==false');
    expect(page).toContain('setServerPendingDocuments(valid)');
  });
  it("shows recovered documents and allows opening audit without any new upload",()=>{
    expect(page).toContain("Dokumen PENDING tersimpan di server");
    expect(page).toContain("Buka audit dokumen");
    expect(page).toContain('setPendingEvidence({transactionId:doc.transactionId,status:"PENDING_VERIFICATION"})');
    expect(page).toContain("setReviewedUpload(null);setVerifiedId(null)");
    expect(page).toContain('Periksa integritas PDF (baca-saja)');
  });
  it("server uses protected SELECT and never sends private file or authorization",()=>{
    expect(api).toContain('router.get(PATH + "/documents/pending", cashDocumentRateLimit');
    expect(api).toContain('public.sc_future_cash_documents d');
    expect(api).toContain('public.sc_future_cash_document_events e');
    expect(api).toContain('limit 20');
    expect(api).toContain('postingAllowed: false');
    const section=api.slice(api.indexOf('router.get(PATH + "/documents/pending"'),
      api.indexOf('router.post(PATH + "/preview"'));
    expect(section).not.toContain("insert into");
    expect(section).not.toContain("object_path");
    expect(section).not.toContain("document_sha256");
    expect(section).not.toContain("uploaded_by");
  });
});
