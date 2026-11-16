import { describe, expect, it, vi } from "vitest";
import { getEmployeeResignKasbonPrecheck } from "./hrd-resign-kasbon-precheck";

// Regression contract carried forward from the legacy repository without
// enabling the legacy HRD PROD mutation route or changing the canonical reader.
const row = (overrides: Record<string, unknown> = {}) => ({
  unverifiedCount: "0",
  unverifiedAmount: "0.00",
  verifiedUnsettledCount: "0",
  verifiedUnsettledAmount: "0.00",
  activeReservations: "0",
  activeReservationAmount: "0.00",
  ...overrides,
});

const client = (rows: unknown[]) => ({
  query: vi.fn(async (_sql: string, _args: unknown[]) => ({
    rowCount: rows.length,
    rows,
  })),
});

describe("canonical HRD resignation kasbon precheck parity", () => {
  it("rejects invalid or cross-scope identifiers without executing SQL", async () => {
    const db = client([row()]);
    await expect(getEmployeeResignKasbonPrecheck(db as any, 0, 38)).rejects.toThrow("HRD_KASBON_PREFLIGHT_BAD_ID");
    await expect(getEmployeeResignKasbonPrecheck(db as any, 1, -1)).rejects.toThrow("HRD_KASBON_PREFLIGHT_BAD_ID");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("uses only the scoped aggregate and never writes financial records", async () => {
    const db = client([row()]);
    const result = await getEmployeeResignKasbonPrecheck(db as any, 2, 38);
    expect(result).toMatchObject({ hasUnresolved: false, canDeactivate: true });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, args] = db.query.mock.calls[0];
    expect(sql).toContain("hrd_private.employee_resign_kasbon_precheck");
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/i);
    expect(args).toEqual([2, 38]);
  });

  it.each([
    ["unverified", { unverifiedCount: "1", unverifiedAmount: "100000.00" }],
    ["unsettled", { verifiedUnsettledCount: "1", verifiedUnsettledAmount: "20000.00" }],
    ["reserved", { activeReservations: "1", activeReservationAmount: "20000.00" }],
  ])("blocks resignation while %s kasbon remains", async (_name, overrides) => {
    const db = client([row(overrides)]);
    const result = await getEmployeeResignKasbonPrecheck(db as any, 1, 38);
    expect(result.hasUnresolved).toBe(true);
    expect(result.canDeactivate).toBe(false);
  });

  it("fails closed on malformed totals and missing aggregate rows", async () => {
    await expect(getEmployeeResignKasbonPrecheck(client([row({ activeReservations: "-1" })]) as any, 1, 38))
      .rejects.toThrow("HRD_KASBON_PREFLIGHT_INVALID_COUNT");
    await expect(getEmployeeResignKasbonPrecheck(client([row({ verifiedUnsettledAmount: "NaN" })]) as any, 1, 38))
      .rejects.toThrow("HRD_KASBON_PREFLIGHT_INVALID_AMOUNT");
    await expect(getEmployeeResignKasbonPrecheck(client([]) as any, 1, 38))
      .rejects.toThrow("HRD_KASBON_PREFLIGHT_NO_RESULT");
  });
});
