/**
 * Evidence-only counter-COA gate for Kas Besar SC.
 * This module never infers accounting treatment from narration/keywords,
 * and never writes or approves a journal.
 */
export type CashEvidenceScope = Readonly<{
  companyId: number; configId: number; accountId: number; cashCoaId: number;
}>;
export type CounterCoaRecord = Readonly<{
  id: number; companyId: number; isActive: boolean;
  isPostable: boolean; isHeader: boolean;
}>;
export type CounterCoaEvidence = Readonly<{
  rowNumber: number;
  sourceFingerprint: string;
  counterCoaId: number;
  verifiedSourceType: "journal" | "supplier_invoice" | "approved_cash_document";
  verifiedSourceId: string;
  verifiedBy: string;
}>;
export type CounterCoaDecision = Readonly<{
  rowNumber: number; eligibleForReadOnlyDraft: boolean;
  code: "EVIDENCE_VALID" | "EVIDENCE_MISSING" | "INVALID_SOURCE" |
    "COA_NOT_POSTABLE" | "COA_WRONG_COMPANY" | "CASH_SELF_COUNTER" |
    "UNVERIFIED_EVIDENCE";
  counterCoaId: number | null;
}>;
const valid = (n: number) => Number.isSafeInteger(n) && n > 0;

export function assessCashCounterCoaEvidence(
  scope: CashEvidenceScope,
  sourceRows: readonly { rowNumber: number; sourceFingerprint: string }[],
  evidences: readonly CounterCoaEvidence[],
  coaRecords: readonly CounterCoaRecord[],
): { decisions: CounterCoaDecision[]; verified: number; blocked: number; readyForCommit: false } {
  if (scope.companyId !== 1 || scope.configId !== 5 ||
      scope.accountId !== 18 || scope.cashCoaId !== 75839) {
    throw new Error("CASH_COUNTER_COA_SCOPE_NOT_AUTHORIZED");
  }
  if (sourceRows.length > 1000 || evidences.length > 1000 || coaRecords.length > 1000) {
    throw new Error("CASH_COUNTER_COA_BATCH_TOO_LARGE");
  }
  const byRow = new Map<number, CounterCoaEvidence[]>();
  for (const evidence of evidences) {
    const sameRow = byRow.get(evidence.rowNumber) ?? [];
    sameRow.push(evidence);
    byRow.set(evidence.rowNumber, sameRow);
  }
  const coaById = new Map(coaRecords.map(coa => [coa.id, coa]));
  const seenRows = new Set<number>();
  const decisions = sourceRows.map((row): CounterCoaDecision => {
    const blocked = (code: CounterCoaDecision["code"]): CounterCoaDecision =>
      ({ rowNumber: row.rowNumber, eligibleForReadOnlyDraft: false, code, counterCoaId: null });
    if (!valid(row.rowNumber) || seenRows.has(row.rowNumber) ||
        !/^[a-f0-9]{64}$/.test(row.sourceFingerprint)) return blocked("INVALID_SOURCE");
    seenRows.add(row.rowNumber);
    const matches = byRow.get(row.rowNumber) ?? [];
    if (!matches.length) return blocked("EVIDENCE_MISSING");
    // Duplicate, mismatched or incomplete proofs are blocked, not chosen heuristically.
    if (matches.length !== 1) return blocked("UNVERIFIED_EVIDENCE");
    const proof = matches[0]!;
    if (proof.sourceFingerprint !== row.sourceFingerprint ||
        !valid(proof.counterCoaId) ||
        !["journal", "supplier_invoice", "approved_cash_document"].includes(proof.verifiedSourceType) ||
        !/^[a-zA-Z0-9._:/-]{3,120}$/.test(proof.verifiedSourceId) ||
        !/^[a-zA-Z0-9@._-]{3,120}$/.test(proof.verifiedBy)) {
      return blocked("UNVERIFIED_EVIDENCE");
    }
    if (proof.counterCoaId === scope.cashCoaId) return blocked("CASH_SELF_COUNTER");
    const coa = coaById.get(proof.counterCoaId);
    if (!coa || coa.companyId !== scope.companyId) return blocked("COA_WRONG_COMPANY");
    if (!coa.isActive || !coa.isPostable || coa.isHeader) return blocked("COA_NOT_POSTABLE");
    return { rowNumber: row.rowNumber, eligibleForReadOnlyDraft: true,
      code: "EVIDENCE_VALID", counterCoaId: coa.id };
  });
  const verified = decisions.filter(item => item.eligibleForReadOnlyDraft).length;
  return { decisions, verified, blocked: decisions.length-verified, readyForCommit: false };
}
