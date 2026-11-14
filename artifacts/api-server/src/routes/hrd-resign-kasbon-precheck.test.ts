import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { getEmployeeResignKasbonPrecheck } from "./hrd-resign-kasbon-precheck";

type RecordRow = Record<string, unknown>;
const clearRow = (): RecordRow => ({
  unverifiedCount: "0",
  unverifiedAmount: "0",
  verifiedUnsettledCount: "0",
  verifiedUnsettledAmount: "0",
  activeReservations: "0",
  activeReservationAmount: "0",
});
function clientFor(row: RecordRow | null, rowCount = row ? 1 : 0) {
  const query = vi.fn().mockResolvedValue({ rowCount, rows: row ? [row] : [] });
  return { client: { query } as unknown as Pick<PoolClient, "query">, query };
}

describe("HRD resignation kasbon preflight (not mounted)", () => {
  it("fails closed for invalid company or employee identifiers before querying", async () => {
    const { client, query } = clientFor(clearRow());
    await expect(getEmployeeResignKasbonPrecheck(client, 0, 1)).rejects.toThrow("HRD_KASBON_PREFLIGHT_BAD_ID");
    await expect(getEmployeeResignKasbonPrecheck(client, 1, -1)).rejects.toThrow("HRD_KASBON_PREFLIGHT_BAD_ID");
    await expect(getEmployeeResignKasbonPrecheck(client, 1.1, 2)).rejects.toThrow("HRD_KASBON_PREFLIGHT_BAD_ID");
    expect(query).not.toHaveBeenCalled();
  });
  it("uses parameterized company and employee arguments", async () => {
    const { client, query } = clientFor(clearRow());
    const result = await getEmployeeResignKasbonPrecheck(client, 1, 22);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("hrd_private.employee_resign_kasbon_precheck($1::integer,$2::integer)");
    expect(query.mock.calls[0][1]).toEqual([1, 22]);
    expect(result).toMatchObject({ hasUnresolved: false, canDeactivate: true });
  });
  it.each(["unverifiedCount", "verifiedUnsettledCount", "activeReservations"])(
    "blocks deactivation when %s is nonzero", async (field) => {
      const row = { ...clearRow(), [field]: "1" };
      const { client } = clientFor(row);
      await expect(getEmployeeResignKasbonPrecheck(client, 1, 2))
        .resolves.toMatchObject({ hasUnresolved: true, canDeactivate: false });
    },
  );
  it("rejects invalid and missing financial aggregates rather than treating them as zero", async () => {
    for (const row of [
      { ...clearRow(), activeReservations: "-1" },
      { ...clearRow(), verifiedUnsettledAmount: "NaN" },
      { ...clearRow(), unverifiedAmount: "-100" },
      { ...clearRow(), unverifiedCount: "1.5" },
      { ...clearRow(), activeReservationAmount: null },
      { ...clearRow(), unverifiedCount: null },
    ]) {
      const { client } = clientFor(row);
      await expect(getEmployeeResignKasbonPrecheck(client, 1, 2)).rejects.toThrow(/HRD_KASBON_PREFLIGHT_INVALID_/);
    }
  });
  it("rejects empty SQL results", async () => {
    const { client } = clientFor(null);
    await expect(getEmployeeResignKasbonPrecheck(client, 1, 2)).rejects.toThrow("HRD_KASBON_PREFLIGHT_NO_RESULT");
  });
});
