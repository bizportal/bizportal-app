import type {
  CashEvidenceScope,
  CounterCoaEvidence,
} from "./cash-counter-coa-evidence";
import type { CashDraftRow } from "./cash-ledger-draft-planner";

/**
 * This function accepts only snapshots fetched by a TRUSTED server-side,
 * company-scoped, read-only repository. It cannot certify that a supplied
 * record is genuine: storage ACL, verifier identity, document signature,
 * and receipt integrity remain responsibilities of the repository.
 * No production repository/writer/endpoints are wired here.
 */
export type VerifiedCashDocumentSnapshot = Readonly<{
  documentId: string;
  documentType: "journal" | "supplier_invoice" | "approved_cash_document";
  companyId: number;
  cashAccountId: number;
  sourceConfigId: number;
  physicalRow: number;
  sourceFingerprint: string;
  date: string;
  direction: "IN" | "OUT";
  amountCents: number;
  counterCoaId: number;
  documentStatus: "VERIFIED" | "DRAFT" | "REVOKED";
  verifiedBy: string | null;
  verifiedAt: string | null;
}>;
export type DocumentProofOutcome = Readonly<{
  verifiedEvidence: readonly CounterCoaEvidence[];
  verified: number;
  blocked: number;
  reasonCounts: Readonly<Record<string, number>>;
  readyForCommit: false;
}>;

function goodDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}
const positive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
const fingerprintValid = (s: string): boolean => /^[a-f0-9]{64}$/.test(s);

export function validateCashDocumentProofs(
  scope: CashEvidenceScope,
  parsedRows: readonly CashDraftRow[],
  verifiedDocumentSnapshots: readonly VerifiedCashDocumentSnapshot[],
): DocumentProofOutcome {
  if (scope.companyId !== 1 || scope.configId !== 5 ||
      scope.accountId !== 18 || scope.cashCoaId !== 75839) {
    throw new Error("CASH_DOCUMENT_PROOF_SCOPE_INVALID");
  }
  if (parsedRows.length > 1000 || verifiedDocumentSnapshots.length > 1000) {
    throw new Error("CASH_DOCUMENT_PROOF_BATCH_LIMIT");
  }
  const byRow = new Map<number, VerifiedCashDocumentSnapshot[]>();
  const seenDocIds = new Set<string>();
  const ambiguousDocs = new Set<string>();
  for (const doc of verifiedDocumentSnapshots) {
    const matches = byRow.get(doc.physicalRow) ?? [];
    matches.push(doc);
    byRow.set(doc.physicalRow, matches);
    if (seenDocIds.has(doc.documentId)) ambiguousDocs.add(doc.documentId);
    seenDocIds.add(doc.documentId);
  }
  const reasonCounts: Record<string, number> = {};
  const verifiedEvidence: CounterCoaEvidence[] = [];
  // Count all physical source identities before processing any proof.
  // A duplicated row must invalidate every occurrence, including the first.
  const sourceRowCounts = new Map<number, number>();
  for (const row of parsedRows) {
    sourceRowCounts.set(row.rowNumber, (sourceRowCounts.get(row.rowNumber) ?? 0) + 1);
  }
  const block = (reason: string): void => {
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  };
  for (const row of parsedRows) {
    if (!positive(row.rowNumber) || sourceRowCounts.get(row.rowNumber) !== 1
      || !fingerprintValid(row.sourceFingerprint) || !positive(row.amountCents)
      || !goodDate(row.transactionDate) ||
      !["IN","OUT"].includes(row.direction)) {
      block("INVALID_SOURCE_ROW");
      continue;
    }
    const docs = byRow.get(row.rowNumber) ?? [];
    if (docs.length === 0) { block("MISSING_DOCUMENT"); continue; }
    if (docs.length !== 1 || ambiguousDocs.has(docs[0]!.documentId)) {
      block("AMBIGUOUS_DOCUMENT");
      continue;
    }
    const doc = docs[0]!;
    if (doc.documentStatus !== "VERIFIED" ||
        doc.companyId !== scope.companyId || doc.cashAccountId !== scope.accountId ||
        doc.sourceConfigId !== scope.configId || doc.physicalRow !== row.rowNumber ||
        doc.sourceFingerprint !== row.sourceFingerprint ||
        doc.date !== row.transactionDate || doc.direction !== row.direction ||
        doc.amountCents !== row.amountCents ||
        !positive(doc.counterCoaId) || doc.counterCoaId === scope.cashCoaId ||
        !/^[a-zA-Z0-9._:/-]{3,120}$/.test(doc.documentId) ||
        !/^[a-zA-Z0-9@._-]{3,120}$/.test(doc.verifiedBy ?? "") ||
        !doc.verifiedAt || !Number.isFinite(Date.parse(doc.verifiedAt)) ||
        !["journal","supplier_invoice","approved_cash_document"].includes(doc.documentType)) {
      block("DOCUMENT_SOURCE_MISMATCH_OR_UNVERIFIED");
      continue;
    }
    verifiedEvidence.push({
      rowNumber:row.rowNumber, sourceFingerprint:row.sourceFingerprint,
      counterCoaId:doc.counterCoaId, verifiedSourceId:doc.documentId,
      verifiedSourceType:doc.documentType, verifiedBy:doc.verifiedBy!,
    });
  }
  return { verifiedEvidence, verified:verifiedEvidence.length,
    blocked:parsedRows.length-verifiedEvidence.length,reasonCounts,
    readyForCommit:false };
}
