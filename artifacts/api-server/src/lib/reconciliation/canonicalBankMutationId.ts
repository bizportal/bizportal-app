/** Normalize PostgreSQL int8 IDs without accepting truncated or unsafe numbers. */
export function normalizeCanonicalBankMutationId(value: unknown): number | null {
  if (value == null) return null;
  // pg parses bigint/int8 as string by default. Do not silently coerce
  // fractional, scientific, or hexadecimal input to an unrelated integer.
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("CANONICAL_BANK_MUTATION_ID_INVALID");
  }
  if (typeof value === "string" && !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("CANONICAL_BANK_MUTATION_ID_INVALID");
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("CANONICAL_BANK_MUTATION_ID_INVALID");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("CANONICAL_BANK_MUTATION_ID_INVALID");
  }
  return id;
}
