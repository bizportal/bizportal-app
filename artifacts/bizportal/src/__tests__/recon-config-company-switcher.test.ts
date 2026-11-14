import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(process.cwd(), "src/pages/finance/recon-config/index.tsx"), "utf8");
const companySwitcher = readFileSync(resolve(process.cwd(), "src/components/CompanySwitcher.tsx"), "utf8");
const source = readFileSync(resolve(process.cwd(), "src/pages/finance/recon-config/InvoiceSourcesTab.tsx"), "utf8");

describe("Bank Reconciliation Config company selection", () => {
  it("reuses the existing CompanySwitcher on the standalone page", () => {
    expect(page).toContain('import { CompanySwitcher } from "@/components/CompanySwitcher"');
    expect(page).toContain('data-testid="recon-config-company-switcher"');
    expect(page).toContain("<CompanySwitcher />");
    expect(page).toContain('flex flex-wrap items-center gap-3');
  });

  it("selects companies through the existing authenticated CompanyContext", () => {
    expect(companySwitcher).toContain("useCompany()");
    expect(companySwitcher).toContain("setActiveCompany(company)");
    expect(companySwitcher).toContain("company.companyName");
  });

  it("keeps Gmail status scoped to the selected company id", () => {
    expect(source).toContain('data-testid="gmail-invoice-active-company"');
    expect(source).toContain('company_id=${companyId}');
    expect(source).toContain("status && companyId && !status.connected");
    expect(source).not.toContain("GMAIL_INVOICE_SOURCE_5_REFRESH_TOKEN");
  });
});
