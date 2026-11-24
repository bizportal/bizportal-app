import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scopeBankMutationRead } from "./bank-mutation-read-scope";

describe("bank mutation read authorization", () => {
  it("binds the signed actor company even with no UI company filter", () => {
    const original = { where: "true and bm.status = $1", values: ["posted"], companyId: null };
    const scoped = scopeBankMutationRead(original, 1);
    expect(scoped).toEqual({
      where: "(true and bm.status = $1) and bm.company_id = $2",
      values: ["posted", 1],
    });
    expect(original.values).toEqual(["posted"]);
  });

  it("keeps matching selected company but rejects cross-company and unverified accounts", () => {
    expect(scopeBankMutationRead(
      { where: "bm.company_id = $1", values: [2], companyId: 2 },
      2,
    )).toEqual({
      where: "(bm.company_id = $1) and bm.company_id = $2",
      values: [2, 2],
    });
    expect(() => scopeBankMutationRead({where:"true",values:[],companyId:2},1)).toThrow("COMPANY_SCOPE_FORBIDDEN");
    for (const value of [null, 0, -1, 1.5, NaN]) {
      expect(() => scopeBankMutationRead({where:"true",values:[],companyId:null},value)).toThrow("UNVERIFIED_ACTOR_COMPANY");
    }
  });

  it("allows only a verified unbound Super Admin to read an explicitly selected company", () => {
    const original = { where: "bm.company_id = $1 and bm.status = $2", values: [1, "posted"], companyId: 1 };
    expect(scopeBankMutationRead(original, null, true)).toEqual({
      where: "(bm.company_id = $1 and bm.status = $2) and bm.company_id = $3",
      values: [1, "posted", 1],
    });
    expect(original.values).toEqual([1, "posted"]);
    for (const invalid of [null, 0, -1, 1.5, NaN]) {
      expect(() => scopeBankMutationRead({where:"true",values:[],companyId:invalid},null,true))
        .toThrow("UNVERIFIED_ACTOR_COMPANY");
    }
    expect(() => scopeBankMutationRead(original,null,false)).toThrow("UNVERIFIED_ACTOR_COMPANY");
    expect(() => scopeBankMutationRead({where:"true",values:[],companyId:3},1,true))
      .toThrow("COMPANY_SCOPE_FORBIDDEN");
  });

  it("requires session checks before either bank mutation read reaches the database", () => {
    const src = readFileSync(resolve(process.cwd(),"src/routes/bank-reconciliation.ts"),"utf8");
    for (const [route, next] of [
      ['router.get("/bank-reconciliation/mutations",','router.get("/bank-reconciliation/summary",'],
      ['router.get("/bank-reconciliation/summary",','function isBlockedProductionSheetConfig('],
    ]) {
      const begin = src.indexOf(route);
      const end = src.indexOf(next,begin+route.length);
      expect(begin).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(begin);
      const segment=src.slice(begin,end);
      const check=segment.indexOf("const actor = await getApprovalActor(req)");
      const scope=segment.indexOf("scopeBankMutationRead(");
      const query=segment.indexOf("await pool.query(");
      expect(check).toBeGreaterThan(-1);
      expect(scope).toBeGreaterThan(check);
      expect(query).toBeGreaterThan(scope);
      expect(segment).toContain('res.status(401)');
      expect(segment).toContain('res.status(403)');
    }
  });

  it("compares canonical QRIS settlement bigint IDs to text candidate IDs safely", () => {
    const src = readFileSync(resolve(process.cwd(), "src/routes/bank-reconciliation.ts"), "utf8");
    expect(src).not.toContain("settlement_batch.id = settlement_match.candidate_id");
    expect(src.split("settlement_batch.id::text = settlement_match.candidate_id").length - 1).toBe(2);
    expect(src).toContain("rule_match.candidate_id = rule.id::text");
  });

  it("honors signed OTP sessions ahead of the development-only legacy session", () => {
    const src=readFileSync(resolve(process.cwd(),"src/routes/bank-reconciliation.ts"),"utf8");
    const start=src.indexOf("async function getApprovalActor(request:");
    const end=src.indexOf("function normalizeMatchText(", start);
    const section=src.slice(start,end);
    expect(section.indexOf("getProductionSession(request)")).toBeLessThan(section.indexOf("getDevSession(request)"));
    expect(section).toContain("getProductionUser(signedSession)");
    expect(section).toContain("if (!isDevelopmentEnvironment()) return null;");
  });
});
