import type { PoolClient } from "pg";

/** Read-only, scoped HRD preflight: never mutate employee, kasbon or payroll rows. */
export type HrdResignKasbonPrecheck = {
  unverifiedCount: number;
  unverifiedAmount: string;
  verifiedUnsettledCount: number;
  verifiedUnsettledAmount: string;
  activeReservations: number;
  activeReservationAmount: string;
  hasUnresolved: boolean;
  canDeactivate: boolean;
};

function nonnegativeCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw Error("HRD_KASBON_PREFLIGHT_INVALID_COUNT");
  return n;
}

function nonnegativeAmount(raw: unknown): string {
  const s = String(raw ?? "");
  if (!/^(0|[1-9][0-9]{0,15})(?:\.[0-9]{1,2})?$/.test(s)) {
    throw Error("HRD_KASBON_PREFLIGHT_INVALID_AMOUNT");
  }
  return s;
}

/** Requires the DB function and transaction-scoped app.hrd_company_id; no endpoint mounted here. */
export async function getEmployeeResignKasbonPrecheck(
  client: Pick<PoolClient, "query">, companyId: number, employeeId: number,
): Promise<HrdResignKasbonPrecheck> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 ||
      !Number.isSafeInteger(employeeId) || employeeId <= 0) {
    throw Error("HRD_KASBON_PREFLIGHT_BAD_ID");
  }

  const result = await client.query(
    `SELECT unverified_count AS "unverifiedCount",
            unverified_amount::text AS "unverifiedAmount",
            verified_unsettled_count AS "verifiedUnsettledCount",
            verified_unsettled_amount::text AS "verifiedUnsettledAmount",
            active_reservations AS "activeReservations",
            active_reservation_amount::text AS "activeReservationAmount"
       FROM hrd_private.employee_resign_kasbon_precheck($1::integer,$2::integer)`,
    [companyId, employeeId],
  );
  if (result.rowCount !== 1 || !result.rows[0]) throw Error("HRD_KASBON_PREFLIGHT_NO_RESULT");
  const row = result.rows[0] as Record<string, unknown>;
  const unverifiedCount = nonnegativeCount(row.unverifiedCount);
  const unverifiedAmount = nonnegativeAmount(row.unverifiedAmount);
  const verifiedUnsettledCount = nonnegativeCount(row.verifiedUnsettledCount);
  const verifiedUnsettledAmount = nonnegativeAmount(row.verifiedUnsettledAmount);
  const activeReservations = nonnegativeCount(row.activeReservations);
  const activeReservationAmount = nonnegativeAmount(row.activeReservationAmount);
  const hasUnresolved = unverifiedCount > 0 || verifiedUnsettledCount > 0 || activeReservations > 0;
  return {
    unverifiedCount, unverifiedAmount, verifiedUnsettledCount,
    verifiedUnsettledAmount, activeReservations, activeReservationAmount,
    hasUnresolved, canDeactivate: !hasUnresolved,
  };
}
