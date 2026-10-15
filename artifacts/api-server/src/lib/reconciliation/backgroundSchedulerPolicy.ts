/**
 * DEV never runs autonomous reconciliation or posting jobs by default.
 * Explicit opt-in is only appropriate after the isolated DEV database is ready.
 * The original production scheduling behavior is unchanged.
 */
export function shouldRunReconciliationSchedulers(
  isDevelopment: boolean,
  devOptIn?: string | null,
): boolean {
  return !isDevelopment || devOptIn?.trim().toLowerCase() === "true";
}
