import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nav = readFileSync(resolve(process.cwd(), "src/components/layout/AppShell.tsx"), "utf8");
const routes = readFileSync(resolve(process.cwd(), "src/routes.tsx"), "utf8");
const source = readFileSync(resolve(process.cwd(), "src/pages/finance/recon-config/InvoiceSourcesTab.tsx"), "utf8");

describe("official BizPortal existing HRD navigation", () => {
  it("restores HRD as a dedicated sidebar link to the existing canonical hub", () => {
    expect(nav).toContain('titleKey: "HRD"');
    expect(nav).toContain('href: "/hr"');
    expect(nav).toContain('activePaths: ["/hr"]');
    expect(nav.indexOf('titleKey: "HRD"')).toBeLessThan(nav.indexOf('titleKey: "Biaya Operasional"'));
    expect(routes).toContain('path="/hr"');
  });

  it("preserves built-in super admin access instead of requiring custom permissions", () => {
    expect(nav).toContain('["owner", "admin", "super_admin"].includes(dbUser.role as string)');
  });
});

describe("official BizPortal Gmail source company identity", () => {
  it("shows selected company and explicit tenant id", () => {
    expect(source).toContain('data-testid="gmail-invoice-active-company"');
    expect(source).toContain("activeCompany?.companyName");
    expect(source).toContain("(ID ${companyId})");
  });

  it("does not present an expected mailbox as if it were connected", () => {
    expect(source).toContain('data-testid="gmail-invoice-company-not-connected"');
    expect(source).toContain("status && companyId && !status.connected");
    expect(source).toContain("Mailbox Tujuan (Belum Terhubung)");
    expect(source).toContain("Akun Gmail Terhubung");
  });
});
