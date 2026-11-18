import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bankSheetConfigAccountJoin } from "../lib/bankSheetConfigAccountJoin";

const route = readFileSync(resolve(process.cwd(), "src/routes/bank-reconciliation.ts"), "utf8");
const sync = readFileSync(resolve(process.cwd(), "src/lib/bank-sheet-sync.ts"), "utf8");

describe("legacy CST-DEV Google Sheet connection read-only compatibility", () => {
  it("finds a company-scoped account using the persisted sheet bank number", () => {
    expect(bankSheetConfigAccountJoin).toContain("account.company_id = config.company_id");
    expect(bankSheetConfigAccountJoin).toContain("config.bank_account_number");
    expect(bankSheetConfigAccountJoin).toContain("account.account_number");
    expect(bankSheetConfigAccountJoin).toContain("regexp_replace");
    expect(bankSheetConfigAccountJoin).toContain("count(*)");
    expect(bankSheetConfigAccountJoin).toContain(") = 1");
    expect(bankSheetConfigAccountJoin).not.toContain("config.bank_account_id");
    expect(bankSheetConfigAccountJoin.trimStart().startsWith("left join lateral")).toBe(true);
    expect(bankSheetConfigAccountJoin).not.toMatch(/\b(insert|update|delete|alter|create|drop)\b/i);
  });

  it("uses the compatibility mapping for GET sheet connections", () => {
    const sql = route.slice(route.indexOf("const selectSheetConfigs ="), route.indexOf('router.get("/bank-reconciliation/sheet-configs"'));
    expect(sql).toContain("${bankSheetConfigAccountJoin}");
    expect(sql).toContain("cba.id as bank_account_id");
    expect(sql).not.toContain("config.bank_account_id");
    expect(sql).toContain("config.is_active");
    expect(sql).toContain("config.last_sync_status");
  });

  it("uses the same mapping in both importer readers, without running a sync", () => {
    const start = sync.indexOf("export async function syncOneBankSheetConfig");
    const readers = sync.slice(start);
    expect(readers.match(/\$\{bankSheetConfigAccountJoin\}/g)).toHaveLength(2);
    expect(readers.match(/cba\.id as bank_account_id/g)).toHaveLength(2);
    expect(readers).not.toContain("config.bank_account_id, config.bank_account_number");
  });
});
