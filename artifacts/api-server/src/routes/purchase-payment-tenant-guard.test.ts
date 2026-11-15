import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./purchase-workflow.ts", import.meta.url), "utf8");

describe("Purchase Workflow financial-source tenant and posting guards", () => {
  it("scopes bank mutation evidence to the same company as each payment allocation", () => {
    expect(source).toMatch(
      /left join public\.bank_mutations bm\s+on bm\.id = nullif\(to_jsonb\(pa\)->>'mutation_id', ''\)::bigint\s+and bm\.company_id = nullif\(to_jsonb\(pa\)->>'company_id', ''\)::bigint/,
    );
    expect(source).toMatch(
      /left join public\.bank_mutations bm on bm\.id = pa\.mutation_id\s+and bm\.company_id = pa\.company_id/,
    );
  });

  it("does not treat an unposted payment group as final merely from an allocation identifier", () => {
    expect(source).toContain("lower(coalesce(pmg.status, '')) in ('final', 'posted', 'reconciled')");
    expect(source).toContain("lower(coalesce(bm.status, '')) in ('final', 'posted', 'reconciled')");
    expect(source).toContain("and coalesce(pa.is_active, true) = true");
  });

  it("retains the explicit rollback and 409 guard when an active settlement is detected", () => {
    const start = source.indexOf("const activeSettlement = await client.query");
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf("if (activeSettlement.rows[0])", start);
    expect(end).toBeGreaterThan(start);
    const guardedBlock = source.slice(end, end + 650);
    expect(guardedBlock).toContain('await client.query("rollback")');
    expect(guardedBlock).toContain("409");
  });
});
