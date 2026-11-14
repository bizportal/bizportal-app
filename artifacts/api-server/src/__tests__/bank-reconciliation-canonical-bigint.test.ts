import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCanonicalBankMutationId } from "../lib/reconciliation/canonicalBankMutationId";

describe("canonical QRIS PostgreSQL bigint bank link", () => {
  it("accepts both node-postgres int8 string and safe numeric IDs", () => {
    expect(normalizeCanonicalBankMutationId("434464")).toBe(434464);
    expect(normalizeCanonicalBankMutationId(434464)).toBe(434464);
    expect(normalizeCanonicalBankMutationId(null)).toBeNull();
    expect(normalizeCanonicalBankMutationId(undefined)).toBeNull();
  });

  it("preserves idempotent comparison without falsely accepting a different mutation", () => {
    const linked = normalizeCanonicalBankMutationId("434464");
    expect(linked).toBe(434464);
    expect(linked).not.toBe(434462);
  });

  it.each([
    "0", "-1", "", " 434464", "434464 ", "434464.0",
    "4.34464e5", "0x6a120", "9007199254740992",
    0, -1, 434464.1, Number.NaN, Number.POSITIVE_INFINITY,
    {}, [], true,
  ])("rejects invalid or unsafe canonical link ID %s", value => {
    expect(() => normalizeCanonicalBankMutationId(value)).toThrow("CANONICAL_BANK_MUTATION_ID_INVALID");
  });

  it("keeps the existing approval route linked to strict normalization", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("normalizeCanonicalBankMutationId(");
    expect(src).toContain("CANONICAL_SETTLEMENT_ALREADY_USED");
    expect(src).toContain("if (linkedMutationId != null && linkedMutationId !== mutationId)");
  });
});
