import { describe, expect, it } from "vitest";
import { readOutboundReuseFinalityCounts, type OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

const input = { companyId: 1, mutationId: 90001, invoiceId: 7, entryId: 314 };
function recorder(counts: readonly string[]) {
  const executed: { sql: string; params: readonly (number | string)[] }[] = [];
  let idx = 0;
  const client: OutboundReuseQueryClient = {
    async query<T extends Record<string, unknown>>(sql: string, params: readonly (number | string)[]) {
      executed.push({ sql, params });
      return { rows: [{ n: counts[idx++] }] as unknown as T[] };
    },
  };
  return { client, executed };
}
describe("PR95 real canonical finality evidence reader (unregistered, SELECT only)", () => {
  it("reads matching, allocation, and linked-journal counts from canonical tables", async () => {
    const { client, executed } = recorder(["0", "0", "0"]);
    await expect(readOutboundReuseFinalityCounts(client, input)).resolves.toEqual({
      mutationFinalMatchCount: 0,
      sourceFinalAllocationCount: 0,
      activeApprovedMutationLinkCount: 0,
    });
    expect(executed).toHaveLength(3);
    expect(executed[0].sql).toContain("public.bank_reconciliation_matches");
    expect(executed[0].sql).toContain("mutation_id=$1");
    expect(executed[0].params).toEqual([90001]);
    expect(executed[1].sql).toContain("public.payment_allocations");
    expect(executed[1].sql).toContain("pa.company_id=$1 and pa.invoice_id=$2");
    expect(executed[1].sql).toContain("coalesce(pa.is_active,true)=true");
    expect(executed[1].sql).not.toContain("public.payment_matching_groups");
    expect(executed[1].sql).not.toContain("bm.status");
    expect(executed[1].params).toEqual([1, 7]);
    expect(executed[2].sql).toContain("journal_entry_id=$2");
    expect(executed[2].sql).not.toContain("lower(status) in");
    expect(executed[2].params).toEqual([1, 314]);
    for (const q of executed) {
      expect(q.sql.trimStart().toLowerCase().startsWith("select")).toBe(true);
      expect(q.sql).not.toMatch(/\b(insert|update|delete|create|alter|drop)\s+(into|table|public|from)/i);
    }
  });
  it("returns nonzero duplicate-custody blockers rather than treating them as success", async () => {
    const { client } = recorder(["1", "2", "1"]);
    expect(await readOutboundReuseFinalityCounts(client, input)).toEqual({
      mutationFinalMatchCount: 1, sourceFinalAllocationCount: 2, activeApprovedMutationLinkCount: 1,
    });
  });
  it("fails closed on invalid identity and invalid database count", async () => {
    const bad = recorder(["0", "0", "0"]);
    await expect(readOutboundReuseFinalityCounts(bad.client, { ...input, mutationId: 0 }))
      .rejects.toThrow("PR95_FINALITY_SCOPE_INVALID");
    expect(bad.executed).toHaveLength(0);
    await expect(readOutboundReuseFinalityCounts(recorder(["abc", "0", "0"]).client, input))
      .rejects.toThrow("PR95_FINALITY_COUNT_INVALID");
    await expect(readOutboundReuseFinalityCounts(recorder(["-1", "0", "0"]).client, input))
      .rejects.toThrow("PR95_FINALITY_COUNT_INVALID");
  });
});
