import { assessFutureCashDraft, type FutureCashPreflightResult,
  type TrustedFutureCashApproval, type TrustedFutureCashCoa,
  type TrustedFutureCashReceipt } from "./future-cash-approval-preflight";
import type { FutureCashSource } from "./future-cash-source-identity";

/**
 * Server-side adapter contract for future Account18 voucher evidence.
 *
 * This does not authenticate evidence by itself. The implementation MUST read
 * independently verified facts from a server-owned repository and MUST NOT
 * forward browser-supplied receipt/approval objects to these methods.
 *
 * No database adapter, HTTP route, approval issuer or posting writer exists here.
 */
export interface FutureCashEvidenceReader {
  getVerifiedReceipt(transactionId: string): Promise<TrustedFutureCashReceipt | null>;
  getSignedApproval(transactionId: string): Promise<TrustedFutureCashApproval | null>;
  getCounterCoa(companyId: number, coaId: number): Promise<TrustedFutureCashCoa | null>;
}

export type FutureCashEvidenceReadiness = Readonly<{
  eligibleForReadOnlyDraft: boolean;
  readyForCommit: false;
  reason: FutureCashPreflightResult["reason"] | "EVIDENCE_REPOSITORY_UNAVAILABLE";
}>;

/**
 * Readiness only; deliberately hides keys, fingerprints, approval records and
 * repository details. Never authorizes a journal write, even when eligible.
 */
export async function inspectFutureCashEvidence(
  source: FutureCashSource,
  reader: FutureCashEvidenceReader,
): Promise<FutureCashEvidenceReadiness> {
  try {
    // Validate the future-cash identity before any repository reads.
    // Fail closed if the caller supplies an unsupported account or malformed UUID.
    const { prepareFutureCashSource } = await import("./future-cash-source-identity");
    prepareFutureCashSource(source);

    const receipt = await reader.getVerifiedReceipt(source.transactionId);
    // Never treat an unverified/revoked document as an authorization to fetch
    // additional approval records.
    if (!receipt || receipt.status !== "VERIFIED") {
      return { eligibleForReadOnlyDraft: false, readyForCommit: false,
        reason: "RECEIPT_NOT_VERIFIED" };
    }
    const approval = await reader.getSignedApproval(source.transactionId);
    // The counter COA is sourced from the signed approval's selection, never
    // from a browser-provided accounting allocation.
    const coa = approval?.counterCoaId
      ? await reader.getCounterCoa(source.companyId, approval.counterCoaId) : null;
    const decision = assessFutureCashDraft(source, receipt, approval, coa);
    return { eligibleForReadOnlyDraft: decision.eligibleForReadOnlyDraft,
      readyForCommit: false, reason: decision.reason };
  } catch {
    // Do not expose SQL errors or untrusted repository data to clients.
    return { eligibleForReadOnlyDraft: false, readyForCommit: false,
      reason: "EVIDENCE_REPOSITORY_UNAVAILABLE" };
  }
}
