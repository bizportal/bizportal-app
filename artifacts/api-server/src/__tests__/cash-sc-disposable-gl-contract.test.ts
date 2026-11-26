import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(
  resolve(process.cwd(), "../../scripts/dev/cash-sc-disposable-gl-e2e.sql"),
  "utf8",
);

describe("Cash SC isolated PostgreSQL GL E2E fixture", () => {
  it("only creates temporary objects and always rolls back", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("CREATE TEMP TABLE cash_sc_source_e2e_221");
    expect(sql).toContain("CREATE TEMP TABLE cash_sc_gl_e2e_221");
    expect(sql).toContain("ON COMMIT DROP");
    expect(sql).toContain("ROLLBACK TO SAVEPOINT deliberate_negative_case;");
    expect(sql).toContain("\nROLLBACK;\n");
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+(?:public\.)?(?:bank_mutations|accounting_entries|accounting_entry_lines|petty_cash_transactions)\b/i);
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:bank_mutations|accounting_entries|accounting_entry_lines|petty_cash_transactions|company_bank_accounts|bank_sheet_configs)\b/i);
    expect(sql).not.toMatch(/\bCOMMIT\s*;/i);
  });
  it("asserts 374 synthetic rows, 748 balanced journal legs, replay and negative detection", () => {
    expect(sql).toContain("generate_series(3,376)");
    expect(sql).toContain("source_count<>374");
    expect(sql).toContain("gl_count<>748");
    expect(sql).toContain("replay_count<>0");
    expect(sql).toContain("unbalanced<>0");
    expect(sql).toContain("NEGATIVE_GL_IMBALANCE_NOT_DETECTED");
    expect(sql).toContain("ROLLBACK_TO_SAVEPOINT_FAILED");
    expect(sql).toContain("to_regclass('pg_temp.cash_sc_gl_e2e_221') IS NULL");
  });
});
