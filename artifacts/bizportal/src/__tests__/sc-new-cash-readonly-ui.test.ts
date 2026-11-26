import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page=readFileSync(resolve(process.cwd(),"src/pages/cash-bank/sc-new.tsx"),"utf8");
const routes=readFileSync(resolve(process.cwd(),"src/routes.tsx"),"utf8");
const shell=readFileSync(resolve(process.cwd(),"src/components/layout/AppShell.tsx"),"utf8");

describe("Kas Besar SC future cash UI: DEV-only view and non-posting controls",()=>{
  it("registers a dedicated path and exposes link only on DEV hostname",()=>{
    expect(routes).toContain('<Route path="/cash-bank/sc-new"');
    expect(routes).toContain('import("@/pages/cash-bank/sc-new")');
    expect(shell).toContain('window.location.hostname === "dev-bizportal.cstlogistic.co.id"');
    expect(shell).toContain('href: "/cash-bank/sc-new"');
  });
  it("uses only readiness and mathematical preview, never ledger write endpoint",()=>{
    expect(page).toContain('ENDPOINT+"/readiness?company_id=1"');
    expect(page).toContain('ENDPOINT+"/preview"');
    expect(page).toContain('method:"POST"');
    expect(page).toContain('postingAllowed!==false');
    expect(page).toContain("Uji pratinjau saja (tanpa posting)");
    expect(page).not.toContain('/api/accounting/entries');
    expect(page).not.toContain('cash-bank/petty-cash');
  });
  it("removes previous-company result, validates signed response, and shows posting blocked",()=>{
    expect(page).toContain("controller.abort()");
    expect(page).toContain("version!==companyRequestVersion.current");
    expect(page).toContain("activeCompanyId!==1");
    expect(page).toContain('payload?.account?.id!==18');
    expect(page).toContain('payload?.historicalSheetConfig5!=="NOT_USED_NONMIGRATION"');
    expect(page).toContain("Posting tetap DIBLOKIR");
    expect(page).toContain('role="alert"');
  });
});
