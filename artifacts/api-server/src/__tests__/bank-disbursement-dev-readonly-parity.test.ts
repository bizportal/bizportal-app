import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/routes/accounting.ts"), "utf8");
const start = source.indexOf('router.get("/accounting/bank-disbursements",');
const end = source.indexOf("\n});", start);
const route = source.slice(start, end + 4);

describe("DEV-only Bank Disbursement historical list contract", () => {
  it("is a gated read-only route under the existing Accounting authorization", () => {
    expect(start).toBeGreaterThan(source.indexOf("router.use(async (req, res, next) =>"));
    expect(end).toBeGreaterThan(start);
    expect(route).toContain('process.env.BIZPORTAL_DEV_BD_READONLY_ENABLED !== "true"');
    expect(route).toContain("!isDevelopmentEnvironment()");
    expect(route).toContain('res.status(404).json({ error: "Not found" })');
    expect(route).toContain("private, no-store");
    expect(route).not.toMatch(/router\.(?:post|patch|put|delete)\(/);
  });

  it("requires the authorized company and parameterized bounded read", () => {
    expect(route).toContain("companyId = bankDisbursementReadCompanyId(req)");
    expect(source).toContain("function bankDisbursementReadCompanyId(req: Request)");
    expect(source).toContain("requested === actorCompany ? actorCompany : null");
    expect(route).toContain("if (companyId === null)");
    expect(route).toContain("limit > 100");
    expect(route).toContain("where company_id = $1");
    expect(route).toContain("limit $2");
    expect(route).toContain("[companyId, limit]");
    expect(route).not.toMatch(/\b(?:insert into|update public|delete from|create table)\b/i);
  });

  it("keeps the legacy list response shape without payment write capabilities", () => {
    for (const name of ["disbursementNumber", "journalId", "totalAmount", "entryId", "counterpartyName", "sourceModule"]) {
      expect(route).toContain(name);
    }
    expect(route).not.toContain("postEntry");
    expect(route).not.toContain('"/accounting/bank-disbursements/:id/void"');
  });
});
