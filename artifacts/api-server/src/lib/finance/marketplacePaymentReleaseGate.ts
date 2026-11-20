/**
 * Marketplace AP -> Bank/GL release preflight (DEV design, not mounted).
 * This reads immutable evidence; it NEVER approves, pays, reconciles or posts.
 * Caller must supply an identity verified by getProductionSession/getProductionUser,
 * not a user-controlled body/header value.
 */
export type VerifiedActor = {
  source: "signed_server_session";
  role: "super_admin";
  email: string;
  companyId: number | null;
  approvedGlobalCompanyId?: number;
};
export type FinancialEvidence = {
  ap: { id: number; companyId: number; supplierId: number; invoiceId: number; status: string };
  invoice: { id: number; companyId: number; supplierId: number; status: string; matched: boolean };
  handoff: { id: number; apId: number; invoiceId: number; companyId: number; requestId: number;
    status: string; accountingStatus: string; payloadFingerprint: string };
  request: { id: number; apId: number; companyId: number; supplierId: number; sourceType: string;
    sourceId: number; status: string; amount: string; paidAmount: string; fingerprint: string;
    approvedBy: string | null; approvedAt: string | null; treasuryReadyAt: string | null;
    journalEntryId: number | null; idempotencyKey: string };
  bank: { id: number; companyId: number; direction: string; amount: string; status: string;
    bankAccountId: string | null; journalEntryId: number | null };
  mapping: { companyId: number; bankAccountId: string; bankCoaId: number;
    coaActive: boolean; coaPostable: boolean; bankAccountActive: boolean };
  journal: { id: number; companyId: number; mutationId: number; status: string;
    headerDebit: string; headerCredit: string;
    lines: Array<{ companyId: number; accountId: number; debit: string; credit: string }> };
  reconciliation: { companyId: number; bankMutationId: number; invoiceId: number;
    finalized: boolean; activeDuplicates: number; allocationAmount: string };
  // This can only be true after a reviewed, deployed canonical adapter proves
  // that Marketplace ready_for_ap is reconciled without forging legacy posted.
  bankAdapter: { marketplaceStatusContractProven: boolean; canonicalBindingVerified: boolean };
};
export type ReleaseCheck = { status: "GO_CANDIDATE" | "NO_GO"; blockers: string[] };
function cents(input: string): bigint | null {
  if (!/^(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(input)) return null;
  const [whole, fractional=""] = input.split(".");
  return BigInt(whole)*100n+BigInt((fractional+"00").slice(0,2));
}
function validId(value: number) {return Number.isSafeInteger(value)&&value>0;}
/**
 * Read-only proof checks only. Returning GO_CANDIDATE never authorizes a
 * transfer or a posting: final execution must revalidate under row locks.
 */
export function evaluateMarketplacePaymentRelease(
  actor: VerifiedActor | null,
  e: FinancialEvidence,
): ReleaseCheck {
  const blockers: string[] = [];
  const fail = (code: string, bad: boolean) => {if (bad) blockers.push(code)};
  const req=e.request,ap=e.ap,inv=e.invoice,h=e.handoff,b=e.bank,m=e.mapping,j=e.journal,r=e.reconciliation;
  const company=ap.companyId;
  fail("SIGNED_SUPERADMIN_REQUIRED", !actor || actor.source!=="signed_server_session" || actor.role!=="super_admin");
  fail("COMPANY_SCOPE_MISMATCH", !validId(company) ||
    actor==null || (actor.companyId!==company &&
      !(actor.companyId===null && actor.approvedGlobalCompanyId===company)) ||
    [inv.companyId,h.companyId,req.companyId,b.companyId,m.companyId,j.companyId,r.companyId].some(v=>v!==company) ||
    j.lines.some(l=>l.companyId!==company));
  fail("LINKAGE_MISMATCH", ![ap.id,inv.id,ap.supplierId,req.id,b.id,j.id].every(validId) ||
    ap.invoiceId!==inv.id || ap.supplierId!==inv.supplierId ||
    h.apId!==ap.id || h.invoiceId!==inv.id || h.requestId!==req.id ||
    req.apId!==ap.id || req.supplierId!==ap.supplierId ||
    req.sourceType!=="marketplace_ap" || req.sourceId!==ap.id ||
    req.idempotencyKey!==`mkt-ap:${ap.id}` ||
    h.payloadFingerprint.length!==64 || req.fingerprint!==h.payloadFingerprint);
  fail("AP_NOT_APPROVED_FOR_HANDOFF",ap.status!=="waiting_payment" || inv.status!=="ready_for_ap" || !inv.matched ||
    h.status!=="accepted" || h.accountingStatus!=="draft_not_posted");
  fail("OWNER_APPROVAL_REQUIRED", !req.approvedBy || !req.approvedAt ||
    actor==null || req.approvedBy.toLowerCase()!==actor.email.toLowerCase());
  fail("TREASURY_NOT_READY",!req.treasuryReadyAt || req.status!=="approved");
  fail("PREVIOUS_PAYMENT_OR_POSTING",req.journalEntryId!==null || cents(req.paidAmount)!==0n);
  const expected=cents(req.amount),bankAmount=cents(b.amount),allocated=cents(r.allocationAmount);
  fail("INVALID_OR_MISMATCHED_AMOUNT",expected===null || expected<=0n ||
    bankAmount===null || bankAmount<=0n || bankAmount!==expected || allocated!==expected);
  fail("BANK_SOURCE_UNVERIFIED",b.direction!=="OUT" || b.status!=="approved_pending_posting" ||
    !b.bankAccountId || b.bankAccountId!==m.bankAccountId ||
    !m.bankAccountActive || !m.coaActive || !m.coaPostable || !validId(m.bankCoaId));
  fail("CANONICAL_JOURNAL_MISMATCH",!validId(j.id) || b.journalEntryId!==j.id ||
    j.mutationId!==b.id || j.status!=="draft" ||
    j.lines.length<2 || !j.lines.some(l=>l.accountId===m.bankCoaId));
  const debit=cents(j.headerDebit),credit=cents(j.headerCredit);
  const lineAmounts=j.lines.map(l=>[cents(l.debit),cents(l.credit)]);
  const validLines=lineAmounts.every(([a,c])=>a!==null&&c!==null);
  const sum=(side:0|1)=>lineAmounts.reduce((acc,x)=>acc+(x[side]??0n),0n);
  fail("JOURNAL_UNBALANCED",!validLines || debit===null || credit===null ||
    debit<=0n || debit!==credit || debit!==sum(0) || credit!==sum(1));
  fail("RECONCILIATION_NOT_READY",r.bankMutationId!==b.id || r.invoiceId!==inv.id ||
    r.finalized || r.activeDuplicates!==0);
  fail("MARKETPLACE_BANK_ADAPTER_UNPROVEN",
    !e.bankAdapter.marketplaceStatusContractProven || !e.bankAdapter.canonicalBindingVerified);
  return {status:blockers.length?"NO_GO":"GO_CANDIDATE",blockers};
}
