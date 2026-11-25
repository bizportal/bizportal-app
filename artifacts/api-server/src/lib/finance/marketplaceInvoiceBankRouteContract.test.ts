import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
const source=readFileSync(fileURLToPath(new URL("../../routes/bank-reconciliation.ts",import.meta.url)),"utf8");
describe("DEV Marketplace status bridge in existing Bank Reconciliation",()=>{
 it("is opt-in, development-only and refuses multi-invoice batches",()=>{
  expect(source).toContain('process.env.BIZPORTAL_MARKETPLACE_AP_BANK_STATUS_ADAPTER_DEV !== "true"');
  expect(source).toContain('process.env.APP_ENV !== "development"');
  expect(source).toContain('invoiceResult.rows.length !== 1 || vendorInvoiceIds.length !== 1');
 });
 it("requires genuine signed Super Admin and selected company",()=>{
  expect(source).toContain('const session = getProductionSession(request);');
  expect(source).toContain('const user = session ? await getProductionUser(session) : null;');
  expect(source).toContain('user.role.toLowerCase() !== "super_admin"');
  expect(source).toContain('getFinanceCompanyScope(request, session)');
  expect(source).toContain('const marketplaceActor = await getMarketplaceMatchingActor(req, actor);');
  expect(source).toContain('FINANCE_COMPANY_NOT_VERIFIED');
 });
 it("preserves the legacy posted path and never forges Invoice posted",()=>{
  expect(source).toContain('String(invoice.status).toLowerCase() !== "posted" &&');
  expect(source).toContain('invoice.id !== authorizedMarketplaceInvoiceId');
  expect(source).toContain('authorizeMarketplaceReadyForApBankAllocation(');
  expect(source).not.toMatch(/update public.vendor_invoices\s+set status\s*=\s*'posted'/);
 });
});
