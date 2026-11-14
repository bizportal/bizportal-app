/** Financial reversal is withheld unless an independently approved release is enabled. */
export const recurringVoidEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SPORT_CENTER_RECURRING_VOID_ENABLED === "true" &&
  env.APP_ENV?.trim().toLowerCase() === "production";

export type RecurringVoidActor = { email: string; role: string; companyId: number | null };

const positive = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
};

export const recurringVoidCompanyId = (raw: unknown): number | null => positive(raw);

/** Only verified owner-level users may request any financial reversal. */
export function authorizeRecurringVoid(
  actor: RecurringVoidActor | null,
  companyId: number | null,
): boolean {
  if (!actor || !actor.email.trim() || !companyId) return false;
  if (!["owner", "super_admin"].includes(actor.role.trim().toLowerCase())) return false;
  // Privileged global owners may select the target company explicitly.
  return actor.companyId === null || actor.companyId === companyId;
}

/** Require a payment lookup performed using the runtime's authorized DB identity. */
export function paymentMatchesCompany(
  rows: Array<{ company_id?: unknown }>,
  companyId: number,
): boolean {
  return rows.length === 1 && Number(rows[0]?.company_id) === companyId;
}
