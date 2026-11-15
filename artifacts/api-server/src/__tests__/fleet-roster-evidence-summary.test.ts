import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFleetRosterEvidenceSummary,
  jakartaDay,
  type FleetRosterSourceRow,
} from "../lib/fleet-roster-evidence-summary";

const day = "2026-11-16";
function row(id: number, changes: Partial<FleetRosterSourceRow> = {}): FleetRosterSourceRow {
  return {
    vehicle_id: id,
    company_id: 1,
    vehicle_status: "active",
    driver_status: "active",
    applicator_status: "active",
    source_present_in_latest_snapshot: true,
    has_plate: true,
    plate_occurrences: 1,
    transaction_count: 5,
    last_transaction_date: "2026-11-15",
    ...changes,
  };
}

describe("CST Fleet read-only evidence mode (no dispatch)", () => {
  it("classifies synthetic 44 corroborated and 8 exceptions with 42 recent-seven-day", () => {
    const good = Array.from({ length: 44 }, (_, i) =>
      row(100 + i, { last_transaction_date: i < 42 ? "2026-11-15" : "2026-10-28" }));
    const exceptions = [
      row(9, { driver_status:"inactive", applicator_status:"need_to_assign",
        source_present_in_latest_snapshot:false, transaction_count:37, last_transaction_date:"2026-10-27" }),
      row(28, { driver_status:"inactive", applicator_status:"need_to_assign",
        source_present_in_latest_snapshot:false, transaction_count:0, last_transaction_date:null }),
      row(31, { driver_status:"suspended", applicator_status:"fired",
        transaction_count:22, last_transaction_date:"2026-10-21" }),
      row(51, { driver_status:"inactive", applicator_status:"need_to_assign",
        transaction_count:12, last_transaction_date:"2026-11-09" }),
      row(42, { transaction_count:0, last_transaction_date:null }),
      row(43, { transaction_count:0, last_transaction_date:null }),
      row(15, { source_present_in_latest_snapshot:false,
        transaction_count:36, last_transaction_date:"2026-10-28" }),
      row(37, { transaction_count:12, last_transaction_date:"2026-10-13" }),
    ];
    const result = buildFleetRosterEvidenceSummary([...good, ...exceptions], 1, day);
    expect(result).toMatchObject({
      kind:"fleet_inventory_evidence_only", companyId:1,
      sourceVehicleCount:52, activeDriver:48,
      presentInLatestSnapshot:49, withAnyTransactions:49,
      corroboratedRecent30d:44, corroboratedRecent7d:42, reviewRequired:8,
      permitsDispatch:false, permitsWhatsAppSend:false, permitsFleetSync:false,
    });
    expect(result.exceptions.map(x=>x.vehicleId).sort((a,b)=>a-b))
      .toEqual([9,15,28,31,37,42,43,51]);
    expect(result.exceptions.find(x=>x.vehicleId===15)?.reasons)
      .toContain("driver_missing_from_latest_snapshot");
    expect(result.exceptions.find(x=>x.vehicleId===37)?.reasons)
      .toContain("transaction_older_than_30d");
    expect(JSON.stringify(result)).not.toMatch(/driver_name|driver_phone|vehicle_plate|email|token|secret/i);
  });

  it("fails closed on mismatched tenant, duplicate ID, invalid count or calendar date", () => {
    expect(() => buildFleetRosterEvidenceSummary([row(1,{company_id:2})],1,day))
      .toThrow("FLEET_EVIDENCE_SCOPE");
    expect(() => buildFleetRosterEvidenceSummary([row(1),row(1)],1,day))
      .toThrow("FLEET_EVIDENCE_SCOPE");
    expect(() => buildFleetRosterEvidenceSummary([row(1,{transaction_count:-1})],1,day))
      .toThrow("FLEET_EVIDENCE_SCOPE");
    expect(() => buildFleetRosterEvidenceSummary([row(1)],0,day))
      .toThrow("INVALID_REVIEW_SCOPE");
    expect(() => buildFleetRosterEvidenceSummary([row(1)],1,"2026-02-30"))
      .toThrow("INVALID_REVIEW_SCOPE");
  });

  it("rejects missing/duplicate plates, undated/future/stale transactions and inactive source", () => {
    const result = buildFleetRosterEvidenceSummary([
      row(1,{has_plate:false}), row(2,{plate_occurrences:2}),
      row(3,{transaction_count:1,last_transaction_date:null}),
      row(4,{transaction_count:1,last_transaction_date:"2026-11-18"}),
      row(5,{transaction_count:1,last_transaction_date:"2026-10-15"}),
      row(6,{vehicle_status:"inactive"}),
    ],1,day);
    expect(result.corroboratedRecent30d).toBe(0);
    expect(result.reviewRequired).toBe(6);
    expect(result.exceptions.map(x=>x.reasons[0])).toEqual([
      "plate_missing","duplicate_plate","transaction_date_missing",
      "transaction_date_future","transaction_older_than_30d","vehicle_not_active",
    ]);
  });

  it("uses Jakarta local dates and cannot accept arbitrary browser clock", () => {
    expect(jakartaDay(new Date("2026-11-15T18:00:00Z"))).toBe("2026-11-16");
    expect(jakartaDay(new Date("2026-11-15T16:00:00Z"))).toBe("2026-11-15");
  });

  it("preserves existing Fleet GET, signed admin auth, exact SQL scope and no writes", () => {
    const source = readFileSync(resolve(process.cwd(),"src/routes/fleet-intelligence.ts"),"utf8");
    const segment = source.split('router.get("/vehicles",')[1]?.split('router.post("/vehicles",')[0] ?? "";
    expect(source).toContain("authenticateAdmin(req as AdminRequest");
    expect(segment).toContain("req.query.evidence !== undefined");
    expect(segment).toContain('role !== "owner" && role !== "super_admin"');
    expect(segment).toContain("WHERE v.company_id=$1");
    expect(segment).toContain("WHERE t.company_id=$1");
    expect(segment).toContain("d.company_id=v.company_id::text");
    expect(segment).toContain("res.json({ vehicles: result.rows })");
    expect(segment).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\s+(?:INTO|FROM|TABLE|public\.)/i);
  });
});
