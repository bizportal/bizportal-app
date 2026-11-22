/**
 * Privacy-minimized evidence for a Fleet roster. NOT dispatch or import approval.
 */
export type FleetRosterReviewReason =
  | "vehicle_not_active"
  | "driver_not_active"
  | "applicator_not_active"
  | "driver_missing_from_latest_snapshot"
  | "plate_missing"
  | "duplicate_plate"
  | "transactions_missing"
  | "transaction_date_missing"
  | "transaction_date_future"
  | "transaction_older_than_30d";

export type FleetRosterSourceRow = Readonly<{
  vehicle_id: number;
  company_id: number;
  vehicle_status: string | null;
  driver_status: string | null;
  applicator_status: string | null;
  source_present_in_latest_snapshot: boolean | null;
  has_plate: boolean;
  plate_occurrences: number;
  transaction_count: number;
  last_transaction_date: string | null;
}>;

type ExceptionRow = Readonly<{ vehicleId: number; reasons: FleetRosterReviewReason[] }>;

function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(day + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
function subtractDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function jakartaDay(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("INVALID_REVIEW_DATE");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const val = (type: string) => parts.find((part) => part.type === type)?.value;
  const day = [val("year"), val("month"), val("day")].join("-");
  if (!validDay(day)) throw new Error("INVALID_JAKARTA_DAY");
  return day;
}

/** Only internal vehicle IDs and reason codes, never plates or driver PII. */
export function buildFleetRosterEvidenceSummary(
  rows: readonly FleetRosterSourceRow[],
  expectedCompanyId: number,
  asOfDay: string,
) {
  if (!Number.isSafeInteger(expectedCompanyId) || expectedCompanyId <= 0 ||
      !validDay(asOfDay)) throw new Error("INVALID_REVIEW_SCOPE");
  const cutoff30 = subtractDays(asOfDay, 30);
  const cutoff7 = subtractDays(asOfDay, 7);
  const ids = new Set<number>();
  const exceptions: ExceptionRow[] = [];
  let activeDriver = 0;
  let presentInLatestSnapshot = 0;
  let withAnyTransactions = 0;
  let corroboratedRecent30d = 0;
  let corroboratedRecent7d = 0;

  for (const r of rows) {
    if (!Number.isSafeInteger(r.vehicle_id) || r.vehicle_id <= 0 ||
        ids.has(r.vehicle_id) || r.company_id !== expectedCompanyId ||
        !Number.isSafeInteger(r.plate_occurrences) || r.plate_occurrences <= 0 ||
        !Number.isSafeInteger(r.transaction_count) || r.transaction_count < 0) {
      throw new Error("FLEET_EVIDENCE_SCOPE_OR_CARDINALITY_FAILURE");
    }
    ids.add(r.vehicle_id);
    if (r.driver_status === "active") activeDriver++;
    if (r.source_present_in_latest_snapshot === true) presentInLatestSnapshot++;
    if (r.transaction_count > 0) withAnyTransactions++;

    const reasons: FleetRosterReviewReason[] = [];
    if (r.vehicle_status !== "active") reasons.push("vehicle_not_active");
    if (r.driver_status !== "active") reasons.push("driver_not_active");
    if (r.applicator_status !== "active") reasons.push("applicator_not_active");
    if (r.source_present_in_latest_snapshot !== true)
      reasons.push("driver_missing_from_latest_snapshot");
    if (r.has_plate !== true) reasons.push("plate_missing");
    if (r.plate_occurrences !== 1) reasons.push("duplicate_plate");
    if (r.transaction_count === 0) reasons.push("transactions_missing");
    else if (!r.last_transaction_date || !validDay(r.last_transaction_date))
      reasons.push("transaction_date_missing");
    else if (r.last_transaction_date > asOfDay)
      reasons.push("transaction_date_future");
    else if (r.last_transaction_date < cutoff30)
      reasons.push("transaction_older_than_30d");

    if (reasons.length > 0) {
      exceptions.push({ vehicleId: r.vehicle_id, reasons });
    } else {
      corroboratedRecent30d++;
      if (r.last_transaction_date !== null && r.last_transaction_date >= cutoff7)
        corroboratedRecent7d++;
    }
  }
  return {
    kind: "fleet_inventory_evidence_only" as const,
    companyId: expectedCompanyId,
    asOfDate: asOfDay,
    permitsDispatch: false as const,
    permitsFleetSync: false as const,
    permitsWhatsAppSend: false as const,
    sourceVehicleCount: rows.length,
    activeDriver,
    presentInLatestSnapshot,
    withAnyTransactions,
    corroboratedRecent30d,
    corroboratedRecent7d,
    reviewRequired: exceptions.length,
    exceptions,
  };
}
