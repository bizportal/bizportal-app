import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src=readFileSync(fileURLToPath(new URL("../routes/fleet-finance-integration.ts", import.meta.url)),"utf8");
const a=src.indexOf('router.get("/gojek-rental/preview"');
const b=src.indexOf('router.get("/companies/:companyId/accounting-settings"',a);
const body=src.slice(a,b);

describe("BizPortal dedicated Gojek rental Finance DEV route",()=>{
 it("requires original scoped bearer middleware and dedicated read-only database transaction",()=>{
   expect(a).toBeGreaterThan(0);expect(b).toBeGreaterThan(a);
   expect(src.indexOf("router.use(requireFleetFinanceService)")).toBeLessThan(a);
   expect(body).toContain('process.env.APP_ENV?.trim().toLowerCase() !== "development"');
   expect(body).toContain("requireFleetScope(req, res, targetCompanyId)");
   expect(body).toContain("withFleetFinanceDevTransaction(scope");
   expect(body).toContain("{ readOnly: true }");
   expect(body).toContain("company_id=$1 AND id=ANY($2::int[])");
   expect(body).toContain("company_id=$1 AND code=ANY($2::text[])");
 });
 it("supports exact rental events with explicit company-specific accounts and rejects other types",()=>{
   for(const t of ["Rental fee due","Rental fee deduction","Rental Rebate to Driver - Rental Rebate"])expect(body).toContain(t);
   for(const code of ["1-1025-DV","1-1035-DV","4-1026-DV","4-1027-DV"])expect(body).toContain(code);
   expect(body).toContain('Jenis atau tanda transaksi Gojek tidak valid.');
   expect(body).toContain("accountantApproved");
   expect(body).toContain("postingAllowed:false");
   expect(body).toContain("bankSettlementProven:false");
 });
 it("never writes source, finance ledger or payment",()=>{
   expect(body).not.toMatch(/INSERT INTO|DELETE FROM|UPDATE public\./);
   expect(body).not.toContain("postCashPayment(");
   expect(body).not.toContain("reverseCashPayment(");
   expect(body).toContain('"private, no-store"');
 });
});
