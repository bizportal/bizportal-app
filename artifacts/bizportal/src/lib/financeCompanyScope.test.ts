import { describe, expect, it, vi } from "vitest";
import {
  isSelectableFinanceCompanyId, requestFinanceCompanyScope,
} from "./financeCompanyScope";

function fetchStub(status: number, body: unknown = { ok: true, companyId: 1 }) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
}

describe("Finance company selection UI contract — Issue #76", () => {
  it("does not accept consolidated, negative, fractional, or missing company IDs", async () => {
    for (const value of [0, -3, 2.5, null, undefined, "1", Number.NaN]) {
      expect(isSelectableFinanceCompanyId(value)).toBe(false);
    }
    expect(isSelectableFinanceCompanyId(1)).toBe(true);
    const stub = fetchStub(200);
    await expect(requestFinanceCompanyScope(0, stub)).rejects.toThrow();
    expect(stub).not.toHaveBeenCalled();
  });

  it("requires a deliberate credentialed POST and a matching server confirmation", async () => {
    const stub = fetchStub(200);
    await expect(requestFinanceCompanyScope(1, stub)).resolves.toEqual({
      ok: true, companyId: 1,
    });
    expect(stub).toHaveBeenCalledOnce();
    expect(stub).toHaveBeenCalledWith("/api/mkt/admin/finance-company-selection", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId: 1 }),
    });
  });

  it("rejects a 200 that confirms another company or lacks confirmation", async () => {
    await expect(requestFinanceCompanyScope(1, fetchStub(200, {
      ok: true, companyId: 3,
    }))).rejects.toThrow("tidak mengonfirmasi");
    await expect(requestFinanceCompanyScope(1, fetchStub(200, {
      ok: false,
    }))).rejects.toThrow("tidak mengonfirmasi");
  });

  it("fails closed for unauthenticated, denied, disabled, and invalid selection", async () => {
    for (const status of [401, 403, 404, 422, 503]) {
      await expect(requestFinanceCompanyScope(1, fetchStub(status))).rejects.toThrow();
    }
  });
});
