import { describe, it, expect } from "vitest";
import { prepareCashJournal, postCashJournal, reverseCashJournalLines, type CashLedgerAdapter,
  type CashLedgerTx, type CashJournal, type CashMovement } from "../lib/cash-ledger-posting";
const scope = { companyId: 1, configId: 5, accountId: 18, accountType: "cash" as const,
  cashCoaId: 101, counterpartyCoaId: 202 };
const movement: CashMovement = { rowNumber: 3, date: "2026-11-26", direction: "IN",
  amount: "112.78", sourceFingerprint: "a".repeat(64) };
function store() {
  let rows = new Map<string, { id: string; fingerprint: string }>();
  let journalLines: CashJournal[] = [];
  const adapter: CashLedgerAdapter = { async transaction<T>(callback: (tx: CashLedgerTx) => Promise<T>) {
    const copy = new Map(rows), copyLines = [...journalLines];
    const tx: CashLedgerTx = {
      async findForUpdate(k) { return copy.get(k) ?? null; },
      async insertWithLines(j) {
        if (copy.has(j.sourceKey)) throw new Error("DUPLICATE_SOURCE");
        const id = String(copy.size + 1);
        copy.set(j.sourceKey, { id, fingerprint: j.fingerprint });
        copyLines.push(j);
        return id;
      },
    };
    const result = await callback(tx);
    rows = copy; journalLines = copyLines;
    return result;
  } };
  return { adapter, rows: () => rows, lines: () => journalLines };
}
describe("cash-specific journal contract (isolated adapter, no DB writes)", () => {
  it("uses exact cents and balances IN and OUT against separate COAs", () => {
    const input = prepareCashJournal(scope, movement);
    expect(input.amountCents).toBe(11278n);
    expect(input.lines[0]).toEqual({ accountId: 101, debitCents: 11278n, creditCents: 0n });
    expect(prepareCashJournal(scope, { ...movement, direction: "OUT" }).lines[0].creditCents).toBe(11278n);
    expect(input.lines.reduce((a, b) => a+b.debitCents-b.creditCents, 0n)).toBe(0n);
  });
  it("replays identically and rejects altered source fingerprints", async () => {
    const db = store();
    const original = await postCashJournal(db.adapter, scope, movement);
    expect(original).toEqual({ id: "1", replay: false });
    expect(await postCashJournal(db.adapter, scope, movement)).toEqual({ id: "1", replay: true });
    await expect(postCashJournal(db.adapter, scope, { ...movement,
      sourceFingerprint: "b".repeat(64) })).rejects.toThrow("CASH_SOURCE_CHANGED_REVIEW_REQUIRED");
    expect(db.rows().size).toBe(1);
    expect(db.lines()).toHaveLength(1);
  });
  it("honors company/account/physical-row scope, no implicit dedupe", async () => {
    const db = store();
    await postCashJournal(db.adapter, scope, movement);
    await postCashJournal(db.adapter, scope, { ...movement, rowNumber: 4 });
    await postCashJournal(db.adapter, { ...scope, accountId: 17 }, movement);
    expect(db.rows().size).toBe(3);
  });
  it("reverses the journal without changing the original", () => {
    const plan = prepareCashJournal(scope, movement), reverse = reverseCashJournalLines(plan.lines);
    expect(reverse[0].creditCents).toBe(11278n);
    expect(reverse.reduce((a,b) => a+b.debitCents-b.creditCents,0n)).toBe(0n);
    expect(plan.lines[0].debitCents).toBe(11278n);
  });
  it("rejects invalid dates, amounts, account type and same COA", () => {
    expect(() => prepareCashJournal(scope, { ...movement, date: "2026-02-30" })).toThrow("INVALID_CASH_DATE");
    for (const amount of ["0", "-1", "1.123", "1,000", "1e3", "NaN"]) {
      expect(() => prepareCashJournal(scope, { ...movement, amount })).toThrow("INVALID_CASH_AMOUNT");
    }
    expect(() => prepareCashJournal({ ...scope, accountType: "bank" as "cash" }, movement)).toThrow("CASH_ONLY_ACCOUNT_REQUIRED");
    expect(() => prepareCashJournal({ ...scope, counterpartyCoaId: 101 }, movement)).toThrow("SAME_SIDE_COA_FORBIDDEN");
  });
  it("rolls back a failed journal insertion", async () => {
    const db = store();
    const broken: CashLedgerAdapter = { transaction: cb => db.adapter.transaction(tx => cb({
      findForUpdate: k => tx.findForUpdate(k),
      insertWithLines: async j => { await tx.insertWithLines(j); throw new Error("INJECTED_FAILURE"); },
    })) };
    await expect(postCashJournal(broken, scope, movement)).rejects.toThrow("INJECTED_FAILURE");
    expect(db.rows().size).toBe(0);
    expect(db.lines()).toHaveLength(0);
  });
  it("handles 374 synthetic rows with zero replay inserts", async () => {
    const db = store();
    for (let n=1; n<=374; n++) await postCashJournal(db.adapter, scope,
      { ...movement, rowNumber:n });
    for (let n=1; n<=374; n++) expect((await postCashJournal(db.adapter, scope,
      { ...movement, rowNumber:n })).replay).toBe(true);
    expect(db.rows().size).toBe(374);
    expect(db.lines().length).toBe(374);
  });
});
