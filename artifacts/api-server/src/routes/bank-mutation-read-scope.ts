/** Authorization-side company scope for bank mutation list and summary reads.
 * Never let an "all" or missing filter silently cross company boundaries.
 * Reuses the existing query filter and its ordered bind parameters.
 */
export type BankMutationReadFilter = {
  where: string;
  values: unknown[];
  companyId: number | null;
};

export function scopeBankMutationRead(
  selected: BankMutationReadFilter,
  actorCompanyId: number | null,
): { where: string; values: unknown[] } {
  if (
    typeof actorCompanyId !== "number"
    || !Number.isSafeInteger(actorCompanyId)
    || actorCompanyId <= 0
  ) {
    throw new Error("UNVERIFIED_ACTOR_COMPANY");
  }
  if (selected.companyId !== null && selected.companyId !== actorCompanyId) {
    throw new Error("COMPANY_SCOPE_FORBIDDEN");
  }
  const values = [...selected.values, actorCompanyId];
  return {
    where: `(${selected.where}) and bm.company_id = $${values.length}`,
    values,
  };
}
