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
  verifiedSuperAdmin = false,
): { where: string; values: unknown[] } {
  // A DB-verified cross-company Super Admin may read one explicitly selected
  // company even when the account has no permanent company binding.
  // Refuse unscoped/consolidated requests; do not widen any other role.
  if (actorCompanyId === null && verifiedSuperAdmin) {
    const selectedId = selected.companyId;
    if (typeof selectedId !== "number" || !Number.isSafeInteger(selectedId) || selectedId <= 0) {
      throw new Error("UNVERIFIED_ACTOR_COMPANY");
    }
    const values = [...selected.values, selectedId];
    return {
      where: `(${selected.where}) and bm.company_id = $${values.length}`,
      values,
    };
  }
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
