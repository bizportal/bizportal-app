import { describe, expect, it } from "vitest";
import { assessOutboundSourceJournalReuse, type OutboundReuseEvidence } from "../lib/outboundSourceJournalReuseGate";

const base: OutboundReuseEvidence = {
  companyId: 1,
  invoiceId: 7,
  mutationId: 90001,
  mutationCompanyId: 1,
  mutationDirection: "OUT",
  mutationStatus: "unmatched",
  mutationAmountMinor: 3169439200,
  mutationJournalEntryId: null,
  disbursementCompanyId: 1,
  disbursementInvoiceIds: [7],
  disbursementStatus: "posted",
  disbursementVoidEntryId: null,
  disbursementAmountMinor: 3169439200,
  entryId: 314,
  entryCompanyId: 1,
  entrySource: "manual_payment",
  entryStatus: "posted",
  entryCancelled: false,
  entryVoided: false,
  entryDebitMinor: 3169439200,
  entryCreditMinor: 3169439200,
  lines: [
    { accountId: 1010, debitMinor: 3169439200, creditMinor: 0 },
    { accountId: 1023, debitMinor: 0, creditMinor: 3169439200 },
  ],
  bankAccountId: 1023,
  payableAccountId: 1010,
  postedSourceEntryCount: 1,
  activeApprovedMutationLinkCount: 0,
  outstandingInvoiceMinor: 3169439200,
  requestedWithholdingMinor: 0,
};
const changed = (patch: Partial<OutboundReuseEvidence>) => ({ ...base, ...patch });
const reject = (patch: Partial<OutboundReuseEvidence>, reason: string) =>
  expect(assessOutboundSourceJournalReuse(changed(patch))).toEqual({ eligible: false, reason });

describe("PR95 outgoing bank source-journal reuse: unregistered fail-closed preflight", () => {
  it("accepts exactly one settled source entry with a matching genuine OUT mutation", () => {
    expect(assessOutboundSourceJournalReuse(base)).toEqual({ eligible: true, entryId: 314, mutationId: 90001 });
  });
  it("rejects absent, cross-company, or previously linked bank mutation", () => {
    reject({ mutationId: 0 }, "INVALID_ID");
    reject({ mutationCompanyId: 2 }, "COMPANY_SCOPE_MISMATCH");
    reject({ mutationDirection: "IN" }, "MUTATION_NOT_AVAILABLE");
    reject({ mutationJournalEntryId: 314 }, "MUTATION_NOT_AVAILABLE");
    reject({ mutationStatus: "posted" }, "MUTATION_NOT_AVAILABLE");
  });
  it("rejects reversed, voided and unrelated source journal custody", () => {
    reject({ disbursementStatus: "voided" }, "SOURCE_NOT_POSTED");
    reject({ disbursementVoidEntryId: 315 }, "SOURCE_NOT_POSTED");
    reject({ entryCancelled: true }, "SOURCE_NOT_POSTED");
    reject({ entryVoided: true }, "SOURCE_NOT_POSTED");
    reject({ entrySource: "bank_reconciliation" }, "SOURCE_NOT_POSTED");
    reject({ entryStatus: "draft" }, "SOURCE_NOT_POSTED");
    reject({ disbursementCompanyId: 2 }, "COMPANY_SCOPE_MISMATCH");
  });
  it("rejects orphan, duplicate, and multiple-invoice source entries", () => {
    reject({ disbursementInvoiceIds: [] }, "AMBIGUOUS_SOURCE_CUSTODY");
    reject({ disbursementInvoiceIds: [7, 8] }, "AMBIGUOUS_SOURCE_CUSTODY");
    reject({ disbursementInvoiceIds: [8] }, "AMBIGUOUS_SOURCE_CUSTODY");
    reject({ postedSourceEntryCount: 2 }, "AMBIGUOUS_SOURCE_CUSTODY");
    reject({ activeApprovedMutationLinkCount: 1 }, "AMBIGUOUS_SOURCE_CUSTODY");
  });
  it("rejects mismatch, partial settlement, WHT, or incorrect bank amount", () => {
    reject({ mutationAmountMinor: 3169439100 }, "AMOUNT_OR_PARTIAL_PAYMENT_NOT_PROVEN");
    reject({ outstandingInvoiceMinor: 100 }, "AMOUNT_OR_PARTIAL_PAYMENT_NOT_PROVEN");
    reject({ requestedWithholdingMinor: 100 }, "AMOUNT_OR_PARTIAL_PAYMENT_NOT_PROVEN");
    reject({ disbursementAmountMinor: 0 }, "AMOUNT_OR_PARTIAL_PAYMENT_NOT_PROVEN");
    reject({ entryDebitMinor: 100 }, "ENTRY_TOTAL_MISMATCH");
    reject({ entryCreditMinor: 100 }, "ENTRY_TOTAL_MISMATCH");
  });
  it("rejects balanced-but-wrong COA, line/header mismatch and invalid lines", () => {
    reject({ bankAccountId: 5555 }, "COA_OR_LEDGER_MISMATCH");
    reject({ payableAccountId: 5555 }, "COA_OR_LEDGER_MISMATCH");
    reject({ lines: [{ accountId: 1010, debitMinor: 100, creditMinor: 0 },
      { accountId: 1023, debitMinor: 0, creditMinor: 100 }] }, "COA_OR_LEDGER_MISMATCH");
    reject({ lines: [{ accountId: 1010, debitMinor: 3169439200, creditMinor: 1 },
      { accountId: 1023, debitMinor: 0, creditMinor: 3169439200 }] }, "INVALID_ENTRY_LINE");
  });
});
