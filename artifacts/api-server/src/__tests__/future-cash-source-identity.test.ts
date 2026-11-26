import { describe, expect, it } from "vitest";
import { prepareFutureCashSource, type FutureCashSource } from "../lib/future-cash-source-identity";
import { prepareCashJournal } from "../lib/cash-ledger-posting";

const valid: FutureCashSource = {
  companyId: 1, accountId: 18, cashCoaId: 75839,
  transactionId: "123e4567-e89b-42d3-a456-426614174000",
  sourceDocumentSha256: "a".repeat(64), direction: "IN",
  amount: "150000.25", date: "2026-11-27",
};
const legacy = { companyId: 1, configId: 5, accountId: 18,
  accountType: "cash" as const, cashCoaId: 75839, counterpartyCoaId: 902 };

describe("future Account18 source identity (pure QA, never posted)", () => {
  it("uses a distinct namespace, not historic Config5 source keys", () => {
    const future = prepareFutureCashSource(valid);
    const historic = prepareCashJournal(legacy, {
      rowNumber: 1, date: valid.date, direction: valid.direction,
      amount: valid.amount, sourceFingerprint: valid.sourceDocumentSha256,
    });
    expect(future.sourceKey).toMatch(/^[a-f0-9]{64}$/);
    expect(future.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(future.sourceKey).not.toBe(historic.sourceKey);
    expect(future).toEqual(prepareFutureCashSource(valid));
  });

  it("replays identical evidence but fingerprints changed content under a stable ID", () => {
    const first = prepareFutureCashSource(valid);
    expect(prepareFutureCashSource({ ...valid, sourceDocumentSha256: "b".repeat(64) }).sourceKey).toBe(first.sourceKey);
    expect(prepareFutureCashSource({ ...valid, sourceDocumentSha256: "b".repeat(64) }).sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(prepareFutureCashSource({ ...valid, amount: "150000.26" }).sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(prepareFutureCashSource({ ...valid, direction: "OUT" }).sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(prepareFutureCashSource({ ...valid, transactionId: "123e4567-e89b-42d3-a456-426614174001" }).sourceKey).not.toBe(first.sourceKey);
    expect(() => prepareFutureCashSource({ ...valid, amount: "150000.250" })).toThrow("INVALID_FUTURE_CASH_AMOUNT");
  });

  it("canonicalizes amounts in cents and rejects bad data", () => {
    expect(prepareFutureCashSource({ ...valid, amount: "150000.2" }).sourceFingerprint)
      .toBe(prepareFutureCashSource({ ...valid, amount: "150000.20" }).sourceFingerprint);
    for (const amount of ["0", "-1", "1.234", "1e3", "NaN", "1,000"]) {
      expect(() => prepareFutureCashSource({ ...valid, amount })).toThrow("INVALID_FUTURE_CASH_AMOUNT");
    }
    for (const date of ["2026-02-30", "2026-13-01", "2026/11/27"]) {
      expect(() => prepareFutureCashSource({ ...valid, date })).toThrow("INVALID_FUTURE_CASH_DATE");
    }
    expect(() => prepareFutureCashSource({ ...valid, sourceDocumentSha256: "garbage" }))
      .toThrow("INVALID_FUTURE_CASH_DOCUMENT_FINGERPRINT");
    expect(() => prepareFutureCashSource({ ...valid, transactionId: "sheet-row-1" }))
      .toThrow("INVALID_FUTURE_CASH_TRANSACTION_ID");
  });

  it("fails closed for other companies, accounts and COAs", () => {
    for (const changed of [
      { companyId: 2 }, { accountId: 1 }, { cashCoaId: 49097 },
    ]) {
      expect(() => prepareFutureCashSource({ ...valid, ...changed })).toThrow("UNSUPPORTED_FUTURE_CASH_SCOPE");
    }
  });
});
