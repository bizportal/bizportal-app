import {
  assessCashCounterCoaEvidence,
  type CashEvidenceScope, type CounterCoaRecord, type CounterCoaEvidence,
} from "./cash-counter-coa-evidence";
import {
  planCashLedgerDrafts, type CashDraftRow, type CashDraftScope,
} from "./cash-ledger-draft-planner";

/**
 * Pure, read-only composition of existing source parser/planner and counter
 * COA evidence validator. Input evidence MUST originate in an upstream
 * independently verified, company-scoped document service; this helper
 * cannot authenticate a receipt ID or a verifier string.
 * No route or writer calls this function today.
 */
export function planEvidenceScopedCashDrafts(
  scope: CashDraftScope & CashEvidenceScope,
  parsedRows: readonly CashDraftRow[],
  verifiedEvidence: readonly CounterCoaEvidence[],
  companyCoas: readonly CounterCoaRecord[],
  existingFingerprints: ReadonlyMap<string,string> = new Map(),
) {
  const assessment = assessCashCounterCoaEvidence(
    scope,
    parsedRows.map(row => ({
      rowNumber: row.rowNumber, sourceFingerprint: row.sourceFingerprint,
    })),
    verifiedEvidence, companyCoas,
  );
  const decisions = new Map(assessment.decisions.map(row => [row.rowNumber, row]));
  // Explicitly strip all upstream counter accounts. No caller-supplied row
  // mapping may bypass the evidence gate.
  const guardedRows = parsedRows.map(row => ({
    ...row,
    counterCoaId: decisions.get(row.rowNumber)?.eligibleForReadOnlyDraft
      ? decisions.get(row.rowNumber)!.counterCoaId : null,
  }));
  const plan = planCashLedgerDrafts(scope, guardedRows, existingFingerprints);
  return {
    evidence: {
      eligibleRows: assessment.verified,
      blockedRows: assessment.blocked,
      // Summary only; never reveal evidence text or accounting references.
      reasonCounts: assessment.decisions.reduce<Record<string,number>>((acc,row) => {
        acc[row.code] = (acc[row.code] ?? 0) + 1;
        return acc;
      }, {}),
    },
    draft: {
      proposals: plan.proposals,
      blocked: plan.blocked,
      newRows: plan.newRows,
      replayedRows: plan.replayedRows,
      changedRows: plan.changedRows,
      readyForCommit: false as const,
    },
    readyForCommit: false as const,
    mode: "read_only_evidence_scoped_no_posting" as const,
  };
}
