import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");

describe("Kas Besar SC current document status when Owner previously revoked evidence",()=>{
  it("prioritizes server REVOKED over stale tab/session VERIFIED state",()=>{
    expect(page).toContain("const selectedEvidenceRevoked=!!pendingEvidence && (");
    expect(page).toContain("revokedId===pendingEvidence.transactionId ||");
    expect(page).toContain("serverRevokedDocuments.some(doc=>doc.transactionId===pendingEvidence.transactionId)");
    expect(page).toContain('selectedEvidenceRevoked\n                ? "REVOKED — bukti dinyatakan tidak layak.');
    expect(page).toContain('VERIFIED hanya riwayat integritas lama.');
  });
  it("does not present revoked evidence as a downloadable/verifiable or OTP eligible item",()=>{
    expect(page).toContain('{!selectedEvidenceRevoked && <Button type="button" variant="outline"');
    expect(page).toContain('{!selectedEvidenceRevoked && <a');
    expect(page).toContain('Dokumen REVOKED hanya untuk arsip audit.');
    expect(page).toContain('{!selectedEvidenceRevoked && verifiedId!==pendingEvidence.transactionId');
    expect(page).toContain('{verifiedId===pendingEvidence.transactionId && !selectedEvidenceRevoked');
    expect(page).toContain('REVOKED — kelayakan bukti dicabut.');
    expect(page).not.toContain('"/journal/post"');
  });
});
