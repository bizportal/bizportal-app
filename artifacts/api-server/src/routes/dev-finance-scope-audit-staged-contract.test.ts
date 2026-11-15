import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SOURCE CONTRACT ONLY: does not execute DDL against CST-DEV or PROD.
const policy = readFileSync(resolve(process.cwd(),
  "../../scripts/sql/20261116_pr81_finance_scope_audit_insert_STAGED.sql"), "utf8");
const route = readFileSync(resolve(process.cwd(),
  "src/routes/dev-marketplace-finance-writer.ts"), "utf8");

describe("PR81 staged company-scope audit policy, no live migration", () => {
  it("requires the existing narrowly scoped DEV auth role and delivery policy", () => {
    expect(policy).toContain("bizportal_pr81_otp_login_dev");
    expect(policy).toContain("pr81_auth_delivery_audit_insert");
    expect(policy).toContain("PR81_FINANCE_AUDIT_POLICY_PRECONDITION_FAILED");
    expect(policy).toContain("c.relrowsecurity=true");
    expect(policy).toContain("rolbypassrls=false");
    expect(policy).toContain("rolsuper=false");
  });

  it("authorizes only the existing company-selection audit shape", () => {
    expect(route).toContain("'finance_company_scope_selected'");
    expect(route).toContain('source: "signed_dev_superadmin"');
    expect(route).toContain("'marketplace_finance'");
    for (const expected of [
      "action = 'finance_company_scope_selected'",
      "entity_type = 'company'",
      "company_id IN ('1','3')",
      "entity_id = company_id",
      "module = 'marketplace_finance'",
      "(after_data ->> 'source') = 'signed_dev_superadmin'",
      "(after_data ->> 'selectedCompanyId') = company_id",
    ]) expect(policy).toContain(expected);
  });

  it("does not grant new table access or modify the prior OTP failure policy", () => {
    const stripped = policy.replace(/--[^\n]*/g, "");
    expect(stripped).toMatch(/CREATE POLICY pr81_finance_company_selection_audit_insert/);
    expect(stripped).toMatch(/AS PERMISSIVE FOR INSERT/);
    expect(stripped).not.toMatch(/\bGRANT\b|\bREVOKE\b|\bDROP\b|\bALTER\s+POLICY\b/);
    expect(stripped.match(/\bCREATE POLICY\b/g)).toHaveLength(1);
    expect(stripped.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(stripped.match(/\bCOMMIT;/g)).toHaveLength(1);
    expect(stripped).not.toContain("INSERT INTO");
    expect(policy).toContain("NEVER on PROD");
  });

  it("keeps the signed company scope contingent on server-verification and audit", () => {
    expect(route).toContain("getProductionSession(req)");
    expect(route).toContain("getProductionUser(session)");
    expect(route).toContain("isApprovedFinanceGlobalSuperAdmin(user.email)");
    expect(route).toContain("isApprovedFinanceGlobalCompany(companyId)");
    expect(route).toContain("await pool.query(");
    expect(route).toContain("setFinanceCompanyScopeCookie(res, session, companyId)");
  });
});
