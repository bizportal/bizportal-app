/**
 * PR95 outbound Bank Disbursement source-journal reuse eligibility.
 * Read-only decision boundary: NO SQL mutation, no approval, no route registration.
 * A future authenticated transactional route must lock and collect this evidence.
 * Deliberately restrict to one invoice and exact-cash full settlement until
 * partial invoices and withholding custody have dedicated real E2E evidence.
 */
export type OutboundReuseEvidence = Readonly<{
  companyId: number;
  invoiceId: number;
  mutationId: number;
  mutationCompanyId: number;
  mutationDirection: string;
  mutationStatus: string;
  mutationAmountMinor: number;
  mutationJournalEntryId: number | null;
  disbursementCompanyId: number;
  disbursementInvoiceIds: readonly number[];
  disbursementStatus: string;
  disbursementVoidEntryId: number | null;
  disbursementAmountMinor: number;
  disbursementEntryId: number;
  entryId: number;
  entryCompanyId: number;
  entrySource: string;
  entryStatus: string;
  entryCancelled: boolean;
  entryVoided: boolean;
  entryDebitMinor: number;
  entryCreditMinor: number;
  lines: readonly Readonly<{ accountId: number; debitMinor: number; creditMinor: number }>[];
  bankAccountId: number;
  mutationBankCoaId: number;
  payableAccountId: number;
  postedSourceEntryCount: number;
  activeApprovedMutationLinkCount: number;
  outstandingInvoiceMinor: number;
  requestedWithholdingMinor: number;
}>;

export type OutboundReuseDecision =
  | { eligible: true; entryId: number; mutationId: number }
  | { eligible: false; reason: string };

const positive = (x: number): boolean => Number.isSafeInteger(x) && x > 0;
const nonnegative = (x: number): boolean => Number.isSafeInteger(x) && x >= 0;

/** Never infer bank matching from amount alone. Fail closed for any ambiguity. */
export function assessOutboundSourceJournalReuse(e: OutboundReuseEvidence): OutboundReuseDecision {
  const reject = (reason: string): OutboundReuseDecision => ({ eligible: false, reason });
  if (![e.companyId, e.invoiceId, e.mutationId, e.entryId, e.bankAccountId, e.payableAccountId]
      .every(positive)) return reject("INVALID_ID");
  if (e.companyId !== e.mutationCompanyId
    || e.companyId !== e.disbursementCompanyId
    || e.companyId !== e.entryCompanyId) return reject("COMPANY_SCOPE_MISMATCH");
  if (e.mutationDirection.toUpperCase() !== "OUT"
    || !["unmatched", "matched", "pending", "pending_review"].includes(e.mutationStatus.toLowerCase())
    || e.mutationJournalEntryId !== null) return reject("MUTATION_NOT_AVAILABLE");
  if (e.disbursementEntryId !== e.entryId || e.mutationBankCoaId !== e.bankAccountId)
    return reject("SOURCE_OR_BANK_IDENTITY_MISMATCH");
  if (e.disbursementStatus !== "posted" || e.disbursementVoidEntryId !== null
    || e.entrySource !== "manual_payment" || e.entryStatus !== "posted"
    || e.entryCancelled || e.entryVoided) return reject("SOURCE_NOT_POSTED");
  if (e.disbursementInvoiceIds.length !== 1 || e.disbursementInvoiceIds[0] !== e.invoiceId
    || e.postedSourceEntryCount !== 1 || e.activeApprovedMutationLinkCount !== 0) {
    return reject("AMBIGUOUS_SOURCE_CUSTODY");
  }
  if (!positive(e.mutationAmountMinor) || !positive(e.disbursementAmountMinor)
    || !positive(e.outstandingInvoiceMinor)
    || !nonnegative(e.requestedWithholdingMinor)
    || e.requestedWithholdingMinor !== 0
    || e.mutationAmountMinor !== e.disbursementAmountMinor
    || e.outstandingInvoiceMinor !== e.disbursementAmountMinor) {
    return reject("AMOUNT_OR_PARTIAL_PAYMENT_NOT_PROVEN");
  }
  if (!positive(e.entryDebitMinor) || e.entryDebitMinor !== e.entryCreditMinor
    || e.entryDebitMinor !== e.disbursementAmountMinor || e.lines.length < 2) {
    return reject("ENTRY_TOTAL_MISMATCH");
  }
  let debit = 0;
  let credit = 0;
  let bankCredits = 0;
  let apDebits = 0;
  for (const line of e.lines) {
    if (!positive(line.accountId) || !nonnegative(line.debitMinor)
      || !nonnegative(line.creditMinor)
      || (line.debitMinor > 0 && line.creditMinor > 0)) return reject("INVALID_ENTRY_LINE");
    debit += line.debitMinor;
    credit += line.creditMinor;
    if (line.accountId === e.bankAccountId) bankCredits += line.creditMinor;
    if (line.accountId === e.payableAccountId) apDebits += line.debitMinor;
  }
  if (![debit, credit, bankCredits, apDebits].every(Number.isSafeInteger)
    || debit !== e.entryDebitMinor || credit !== e.entryCreditMinor
    || bankCredits !== e.disbursementAmountMinor
    || apDebits !== e.disbursementAmountMinor) return reject("COA_OR_LEDGER_MISMATCH");
  return { eligible: true, entryId: e.entryId, mutationId: e.mutationId };
}
