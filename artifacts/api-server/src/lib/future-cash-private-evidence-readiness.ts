import type { FutureCashSource } from "./future-cash-source-identity";
import { prepareFutureCashSource } from "./future-cash-source-identity";
import { assessFutureCashDraft, type TrustedFutureCashApproval,
  type TrustedFutureCashCoa } from "./future-cash-approval-preflight";
import { verifyPrivateFutureCashReceipt, type PrivateCashFileReader,
  type ServerOwnedCashDocument } from "./future-cash-private-receipt";

/**
 * Composition only. The implementation of these methods MUST be a
 * server-authenticated repository and existing private ObjectStorageService.
 * Never construct this interface from request body or browser metadata.
 * There is deliberately no HTTP route, approval issuer or journal writer.
 */
export interface PrivateFutureCashEvidenceRepository {
  getDocumentForTransaction(transactionId: string): Promise<ServerOwnedCashDocument | null>;
  getSignedApprovalForTransaction(transactionId: string): Promise<TrustedFutureCashApproval | null>;
  getCompanyCoa(companyId: number, coaId: number): Promise<TrustedFutureCashCoa | null>;
}

export type PrivateFutureCashReadiness = Readonly<{
  eligibleForReadOnlyDraft: boolean;
  readyForCommit: false;
  reason: "ELIGIBLE_FOR_READ_ONLY_DRAFT" | "RECEIPT_NOT_VERIFIED" |
    "SOURCE_MISMATCH" | "APPROVAL_NOT_VERIFIED" | "COA_NOT_ELIGIBLE" |
    "EVIDENCE_REPOSITORY_UNAVAILABLE";
}>;

/**
 * One fail-closed path: canonical source => trusted document record =>
 * actual private stored bytes => signed Owner approval => DB-selected COA.
 * Return no document hashes, approval signatures or source identifiers.
 * This cannot authorize posting, even when every read-only gate passes.
 */
export async function inspectPrivateFutureCashReadiness(
  source: FutureCashSource,
  evidence: PrivateFutureCashEvidenceRepository,
  storage: PrivateCashFileReader,
): Promise<PrivateFutureCashReadiness> {
  const rejected = (reason: PrivateFutureCashReadiness["reason"]): PrivateFutureCashReadiness =>
    ({ eligibleForReadOnlyDraft: false, readyForCommit: false, reason });
  try {
    prepareFutureCashSource(source);
    const document = await evidence.getDocumentForTransaction(source.transactionId);
    const verifiedReceipt = await verifyPrivateFutureCashReceipt(source, document, storage);
    if (!verifiedReceipt) return rejected("RECEIPT_NOT_VERIFIED");
    // Only request approval after the original private bytes have been verified.
    const approval = await evidence.getSignedApprovalForTransaction(source.transactionId);
    const coa = approval?.counterCoaId
      ? await evidence.getCompanyCoa(source.companyId, approval.counterCoaId)
      : null;
    const result = assessFutureCashDraft(source, verifiedReceipt, approval, coa);
    return {
      eligibleForReadOnlyDraft: result.eligibleForReadOnlyDraft,
      readyForCommit: false,
      reason: result.reason,
    };
  } catch {
    // No private storage, SQL or signing details cross this boundary.
    return rejected("EVIDENCE_REPOSITORY_UNAVAILABLE");
  }
}
