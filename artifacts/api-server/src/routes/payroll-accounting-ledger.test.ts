import { describe, expect, it } from "vitest";
import { assertPayrollLedgerMirror, type PayrollLedgerRow, type PayrollJournalLine } from "./payroll-accounting-ledger";

const journal = { companyId: 1, runId: 32, entryNumber: "GENERAL-C1-TEST-1", date: "2026-11-17" };
const lines: PayrollJournalLine[] = [
  { account_id: 10, debit: "5000000.00", credit: "0.00", description: "Synthetic salary" },
  { account_id: 10, debit: "200000.00", credit: "0.00", description: "Synthetic allowance" },
  { account_id: 11, debit: "0.00", credit: "4900000.00", description: "Synthetic payable" },
  { account_id: 12, debit: "0.00", credit: "50000.00", description: "Synthetic tax" },
  { account_id: 13, debit: "0.00", credit: "150000.00", description: "Synthetic BPJS" },
  { account_id: 14, debit: "0.00", credit: "100000.00", description: "Synthetic kasbon" },
];
const mirror = (): PayrollLedgerRow[] => lines.map(line => ({ ...line,
  company_id: 1, ledger_date: "2026-11-17", period: "2026-11", source_type: "payroll",
  source_id: 32, source_ref: journal.entryNumber, currency: "IDR", is_voided: false, void_ref_id: null,
}));
const fail = (rows: PayrollLedgerRow[]) => expect(() => assertPayrollLedgerMirror(journal, lines, rows))
  .toThrow("PAYROLL_ATOMIC_LEDGER_SYNC_NOT_VERIFIED");

describe("read-only Payroll journal to ledger evidence comparison", () => {
  it("accepts exact multiset regardless of row order and never mutates inputs", () => {
    const rows = mirror().reverse(), before = structuredClone(rows), prior = structuredClone(lines);
    expect(() => assertPayrollLedgerMirror(journal, lines, rows)).not.toThrow();
    expect(rows).toEqual(before); expect(lines).toEqual(prior);
  });
  it("compares integer cents rather than decimal formatting", () => {
    const rows = mirror().map(r => ({ ...r, debit: r.debit.replace(/\.00$/, ""), credit: r.credit.replace(/\.00$/, "") }));
    expect(() => assertPayrollLedgerMirror(journal, lines, rows)).not.toThrow();
  });
  it.each(["missing all", "missing one", "duplicate extra", "duplicate replacing one"])("rejects %s ledger rows", condition => {
    const rows = mirror();
    if (condition === "missing all") rows.length = 0;
    if (condition === "missing one") rows.pop();
    if (condition === "duplicate extra") rows.push({ ...rows[0]! });
    if (condition === "duplicate replacing one") rows[1] = { ...rows[0]! };
    fail(rows);
  });
  it.each([
    { company_id: 2 }, { source_type: "manual" }, { source_id: 33 }, { source_id: null },
    { source_ref: "wrong" }, { source_ref: null }, { ledger_date: "2026-11-18" }, { period: "2026-10" },
    { currency: "USD" }, { is_voided: true }, { void_ref_id: "9" }, { description: "changed" },
  ])("rejects changed source or metadata %j", mutation => {
    const rows = mirror(); rows[0] = { ...rows[0]!, ...mutation }; fail(rows);
  });
  it("rejects wrong account even when both aggregate totals remain balanced", () => {
    const rows = mirror(); rows[2] = { ...rows[2]!, account_id: 12 }; fail(rows);
  });
  it("rejects offsetting line changes that preserve aggregate debit and credit", () => {
    const rows = mirror(); rows[2] = { ...rows[2]!, credit: "4899999.00" };
    rows[3] = { ...rows[3]!, credit: "50001.00" }; fail(rows);
  });
  it("rejects debit/credit swap despite equal overall journal totals", () => {
    fail(mirror().map(r => ({ ...r, debit: r.credit, credit: r.debit })));
  });
  it.each(["-1.00", "not-money", "1.001"])("rejects invalid amount %s", amount => {
    const rows = mirror(); rows[0] = { ...rows[0]!, debit: amount }; fail(rows);
  });
  it("rejects zero-value extra line and two-sided line", () => {
    const empty: PayrollJournalLine = { account_id: 10, debit: "0.00", credit: "0.00", description: null };
    expect(() => assertPayrollLedgerMirror(journal, [...lines, empty], [...mirror(), { ...mirror()[0]!, ...empty }]))
      .toThrow("LEDGER_SYNC_NOT_VERIFIED");
    const both = { ...lines[0]!, credit: "1.00" };
    expect(() => assertPayrollLedgerMirror(journal, [both], [{ ...mirror()[0]!, ...both }])).toThrow("LEDGER_SYNC_NOT_VERIFIED");
  });
  it.each([
    { companyId: 0 }, { runId: -1 }, { entryNumber: "" }, { date: "2026-02-30" }, { date: "17/11/2026" },
  ])("rejects invalid trusted journal context %j", mutation => {
    expect(() => assertPayrollLedgerMirror({ ...journal, ...mutation }, lines, mirror())).toThrow("LEDGER_SYNC_NOT_VERIFIED");
  });
  it("rejects empty journal and mirror rather than treating no evidence as success", () => {
    expect(() => assertPayrollLedgerMirror(journal, [], [])).toThrow("LEDGER_SYNC_NOT_VERIFIED");
  });
});
