import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const src = readFileSync(new URL("../accounting.ts", import.meta.url), "utf8");
const engine = readFileSync(new URL("../posting-engine/CanonicalPostingEngine.ts", import.meta.url), "utf8");
const validators = readFileSync(new URL("../posting-engine/validators.ts", import.meta.url), "utf8");

describe("Reused posting owner — transaction fail-closed source contract", () => {
  it("keeps existing posting engine and its four validators byte-identical", () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(sha(engine)).toBe("edac01a988b6a5f241f5e3e50678ef6da6b8e920e0d712a7c4a60de49e3243f4");
    expect(sha(validators)).toBe("4cf0587e2c0e931a533155818e90ada33b14934e1594f9c50f94896cc87870df");
  });

  it("never uses a different DB connection after a failed journal sequence inside a transaction", () => {
    const text = src.slice(src.indexOf("async function _nextEntryNumber("),
      src.indexOf("async function _postEntryCore("));
    expect(text).toContain("if (client !== db)");
    expect(text).toContain("JOURNAL_SEQUENCE_TX_UNAVAILABLE: rollback required");
    expect(text.indexOf("JOURNAL_SEQUENCE_TX_UNAVAILABLE")).toBeLessThan(text.indexOf("await db"));
  });

  it("rejects global enum patching when an INSERT poisoned a caller-owned transaction", () => {
    const text = src.slice(src.indexOf('if (pgCode === "22P02"'), src.indexOf('} else if (pgCode === "P0001"'));
    expect(text).toContain("if (client !== db)");
    expect(text).toContain("JOURNAL_ENUM_TX_UNAVAILABLE: rollback required");
    expect(text.indexOf("JOURNAL_ENUM_TX_UNAVAILABLE")).toBeLessThan(text.indexOf("await applyAccountingEnumPatches()"));
  });

  it("guards all four out-of-transaction effects behind root db identity", () => {
    const start=src.indexOf("  // The ROOT-CALLER legacy path");
    const end=src.indexOf("  return entry;",start);
    expect(start).toBeGreaterThan(0);
    const block=src.slice(start,end);
    expect(block).toContain("  if (client === db) {");
    expect(block).toContain("void postLedgerEvent({");
    expect(block).toContain("void db.execute(");
    expect(block).toContain('import("./accounting/outboxProcessor.js")');
    expect(block).toContain('import("./jobs/ledgerConsistencyCheck.js")');
    expect(block.trimEnd()).toMatch(/\n  \}$/);
  });

  it("preserves company and accounting governance, rather than adding another engine", () => {
    expect(engine).toContain("createDefaultValidators()");
    expect(engine).toContain("postEntryWithClient(client, input");
    for (const name of ["FinancialPeriodValidator","AccountPostingGovernanceValidator","BalanceValidator"]) {
      expect(validators).toContain(name);
    }
    expect(src).toContain("requireAccountingCompanyId(input.companyId)");
    expect(src).toContain("resumeExistingDraft(existing)");
  });

  it("does not mount the staged writer in any running API route", () => {
    const entry=readFileSync(new URL("../../index.ts",import.meta.url),"utf8");
    expect(entry).not.toContain("posting-engine/index");
    expect(entry).not.toContain("postSalesInvoiceWithClient");
  });
});
