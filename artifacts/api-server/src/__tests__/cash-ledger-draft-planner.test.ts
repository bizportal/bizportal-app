import { describe, expect, it } from "vitest";
import { planCashLedgerDrafts, type CashDraftRow } from "../lib/cash-ledger-draft-planner";

const scope = { companyId: 1, configId: 5, accountId: 18, cashCoaId: 75839 };
const sha = "a".repeat(64);

function row(n: number, direction: "IN" | "OUT", counterCoaId: number | null = 75840): CashDraftRow {
  return {
    rowNumber: n, transactionDate: "2026-11-26",
    direction, amountCents: n * 100, sourceFingerprint: sha,
    counterCoaId,
  };
}

describe("CST-DEV cash account 18 draft planner", () => {
  it("balances both IN and OUT against the verified cash COA without a database writer", () => {
    const first = planCashLedgerDrafts(scope, [row(3, "IN"), row(4, "OUT")]);
    expect(first).toMatchObject({ newRows: 2, replayedRows: 0, changedRows: 0, readyForCommit: false, blocked: [] });
    expect(first.proposals[0]?.legs).toEqual([
      { coaId: 75839, side: "DR", amountCents: 300 },
      { coaId: 75840, side: "CR", amountCents: 300 },
    ]);
    expect(first.proposals[1]?.legs).toEqual([
      { coaId: 75840, side: "DR", amountCents: 400 },
      { coaId: 75839, side: "CR", amountCents: 400 },
    ]);
    for (const proposal of first.proposals) {
      expect(proposal.legs.reduce((sum, leg) =>
        sum + (leg.side === "DR" ? leg.amountCents : -leg.amountCents), 0)).toBe(0);
    }
  });

  it("fails closed for no counter COA, same COA, malformed money, duplicate physical row", () => {
    const invalidMoney = { ...row(6, "OUT"), amountCents: 10.5 };
    const result = planCashLedgerDrafts(scope, [
      row(3, "IN", null), row(4, "OUT", 75839), invalidMoney,
      row(7, "IN"), row(7, "IN"),
    ]);
    expect(result.proposals).toHaveLength(1);
    expect(result.blocked.map(x => x.reason)).toEqual([
      "MISSING_COUNTER_COA", "SELF_COUNTER_COA",
      "INVALID_SOURCE", "INVALID_SOURCE",
    ]);
    expect(result.readyForCommit).toBe(false);
  });

  it("makes replay idempotent and flags changed COA or cash source without overwriting", () => {
    const rows = [row(3,"IN"), row(4,"OUT")];
    const initial = planCashLedgerDrafts(scope, rows);
    const existing = new Map(initial.proposals.map(p => [p.sourceKey, p.fingerprint]));
    expect(planCashLedgerDrafts(scope, rows, existing)).toMatchObject({
      newRows: 0, replayedRows: 2, changedRows: 0,
    });
    const changed = rows.map(x => ({ ...x }));
    changed[1]!.counterCoaId = 75841;
    expect(planCashLedgerDrafts(scope, changed, existing)).toMatchObject({
      newRows: 0, replayedRows: 1, changedRows: 1, readyForCommit: false,
    });
    expect(planCashLedgerDrafts(scope, rows).newRows).toBe(2);
  });

  it("refuses wrong scope, batch overflow, and is not tied to the legacy bank writer", () => {
    expect(() => planCashLedgerDrafts({ ...scope, accountId: 17 }, [row(3, "IN")]))
      .toThrow("CASH_DRAFT_SCOPE_NOT_AUTHORIZED");
    expect(() => planCashLedgerDrafts(scope, Array.from({ length: 1001 }, (_, i) => row(i + 3, "IN"))))
      .toThrow("CASH_DRAFT_BATCH_TOO_LARGE");
    expect(planCashLedgerDrafts(scope, [row(3, "IN")]).proposals[0]?.sourceKey)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it("holds 374 synthetic movements at draft stage with no GL posting permission", () => {
    const source = Array.from({ length: 374 }, (_, i) =>
      row(i + 3, i % 2 === 0 ? "IN" : "OUT"));
    const result = planCashLedgerDrafts(scope, source);
    expect(result).toMatchObject({ newRows: 374, changedRows: 0, blocked: [], readyForCommit: false });
    expect(result.proposals).toHaveLength(374);
    expect(new Set(result.proposals.map(p => p.sourceKey)).size).toBe(374);
    expect(result.proposals.flatMap(p => p.legs)).toHaveLength(748);
  });
});
