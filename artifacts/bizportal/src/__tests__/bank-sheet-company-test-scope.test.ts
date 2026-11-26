import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

describe("Google Sheet Test action company scope", () => {
  it("passes the selected company for the expanded SheetConfig list", () => {
    const start = pageSource.indexOf("const testOne = async (cfg: SheetConfig) =>");
    const end = pageSource.indexOf("const syncOne = async (cfg: SheetConfig) =>", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const action = pageSource.slice(start, end);
    expect(action).toContain("cfg.company_id ?? activeCompanyId");
    expect(action).toContain('new URLSearchParams({ company_id: String(companyId) })');
    expect(action).toContain("/test?" + String.fromCharCode(36) + "{params}");
  });

  it("passes the selected company for the collapsed SheetConfig list", () => {
    const component = pageSource.indexOf("function SheetConfigCollapsed()");
    const start = pageSource.indexOf("const testOne = async (cfg: SheetConfig) =>", component);
    const end = pageSource.indexOf("const syncOne = async (cfg: SheetConfig) =>", start);
    expect(component).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(component);
    expect(end).toBeGreaterThan(start);
    const action = pageSource.slice(start, end);
    expect(action).toContain("cfg.company_id ?? sheetCompanyId");
    expect(action).toContain('new URLSearchParams({ company_id: String(companyId) })');
    expect(action).toContain("/test?" + String.fromCharCode(36) + "{params}");
  });
});
