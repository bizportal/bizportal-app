import { prepareFutureCashSource, type FutureCashSource } from "./future-cash-source-identity";

/**
 * Pure QA preflight. The caller MUST obtain receipt and approval facts from
 * independently authenticated server-side repositories, never from request
 * JSON. This module neither verifies OTP signatures nor writes journals.
 */
export type TrustedFutureCashReceipt = Readonly<{
  transactionId: string;
  companyId: number;
  accountId: number;
  sha256: string;
  status: "VERIFIED" | "PENDING" | "REVOKED";
  verifiedAt: string | null;
}>;
export type TrustedFutureCashApproval = Readonly<{
  transactionId: string;
  companyId: number;
  accountId: number;
  sourceFingerprint: string;
  counterCoaId: number;
  status: "APPROVED" | "PENDING" | "REJECTED";
  authenticationMethod: "SIGNED_EMAIL_OTP" | "OTHER";
  authorizedRole: "owner" | "super_admin" | "other";
  approvedAt: string | null;
}>;
export type TrustedFutureCashCoa = Readonly<{
  id: number; companyId: number; isActive: boolean;
  isPostable: boolean; isHeader: boolean;
}>;
export type FutureCashPreflightResult = Readonly<{
  sourceKey: string;
  sourceFingerprint: string;
  counterCoaId: number | null;
  eligibleForReadOnlyDraft: boolean;
  reason: "ELIGIBLE_FOR_READ_ONLY_DRAFT" | "RECEIPT_NOT_VERIFIED" |
    "SOURCE_MISMATCH" | "APPROVAL_NOT_VERIFIED" | "COA_NOT_ELIGIBLE";
  readyForCommit: false;
}>;

const canonicalInstant = (value: string | null): boolean => {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const normalized = parsed.toISOString();
  return value === normalized || value === normalized.replace(/\.000Z$/, "Z") ||
    value === normalized.replace(/0+Z$/, "Z");
};

export function assessFutureCashDraft(
  source: FutureCashSource,
  receipt: TrustedFutureCashReceipt | null,
  approval: TrustedFutureCashApproval | null,
  coa: TrustedFutureCashCoa | null,
): FutureCashPreflightResult {
  const identity = prepareFutureCashSource(source);
  const blocked = (reason: FutureCashPreflightResult["reason"]): FutureCashPreflightResult => ({
    ...identity, counterCoaId: null, eligibleForReadOnlyDraft: false, reason, readyForCommit: false,
  });
  if (!receipt || receipt.status !== "VERIFIED" || !canonicalInstant(receipt.verifiedAt)) {
    return blocked("RECEIPT_NOT_VERIFIED");
  }
  if (receipt.transactionId !== source.transactionId || receipt.companyId !== source.companyId ||
    receipt.accountId !== source.accountId || receipt.sha256 !== source.sourceDocumentSha256) {
    return blocked("SOURCE_MISMATCH");
  }
  if (!approval || approval.status !== "APPROVED" || !canonicalInstant(approval.approvedAt) ||
    approval.authenticationMethod !== "SIGNED_EMAIL_OTP" ||
    !["owner","super_admin"].includes(approval.authorizedRole) ||
    approval.transactionId !== source.transactionId || approval.companyId !== source.companyId ||
    approval.accountId !== source.accountId || approval.sourceFingerprint !== identity.sourceFingerprint ||
    // A prior approval must never authorize a document verified only later.
    Date.parse(approval.approvedAt!) < Date.parse(receipt.verifiedAt!)) {
    return blocked("APPROVAL_NOT_VERIFIED");
  }
  if (!coa || !Number.isSafeInteger(coa.id) || coa.id <= 0 ||
    coa.id === source.cashCoaId || coa.id !== approval.counterCoaId ||
    coa.companyId !== source.companyId || !coa.isActive || !coa.isPostable || coa.isHeader) {
    return blocked("COA_NOT_ELIGIBLE");
  }
  return { ...identity, counterCoaId: coa.id, eligibleForReadOnlyDraft: true,
    reason: "ELIGIBLE_FOR_READ_ONLY_DRAFT", readyForCommit: false };
}
