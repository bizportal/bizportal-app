import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql=readFileSync(resolve(process.cwd(), "scripts/ensure-bank-sheet-account-isolation.sql"),"utf8");

describe("bank Sheet schema cutover must fail closed before any DDL",()=>{
  it("counts orphaned mutation references including already posted source journal",()=>{
    expect(sql).toContain("from public.bank_mutations bm");
    expect(sql).toContain("left join public.bank_sheet_configs cfg on cfg.id=bm.sheet_config_id");
    expect(sql).toContain("bm.sheet_config_id is not null and cfg.id is null");
    expect(sql).toContain("bm.journal_entry_id is not null");
    expect(sql).toContain("BANK_SHEET_CUTOVER_BLOCKED");
  });
  it("runs preflight transaction before changing the schema",()=>{
    expect(sql.indexOf("begin;")).toBeGreaterThan(0);
    expect(sql.indexOf("do $pr147_preflight$")).toBeGreaterThan(sql.indexOf("begin;"));
    expect(sql.indexOf("do $pr147_preflight$")).toBeLessThan(sql.indexOf("alter table public.bank_sheet_configs"));
    expect(sql).toContain("commit;");
  });
});