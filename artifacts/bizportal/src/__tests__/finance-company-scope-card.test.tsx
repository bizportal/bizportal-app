import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceCompanyScopeCard } from "@/pages/purchase/FinanceCompanyScopeCard";

const companyState = vi.hoisted(() => ({
  activeCompanyId: 1,
  isConsolidated: false,
  activeCompany: { id: 1, companyName: "PT CST" },
}));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    ...companyState, isLoading: false,
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  companyState.activeCompanyId = 1;
  companyState.isConsolidated = false;
  companyState.activeCompany = { id: 1, companyName: "PT CST" };
});

describe("Issue #76 deliberate Finance selection in existing Vendor Invoice UI", () => {
  it("never sends an API request on mount; requires explicit confirmation", async () => {
    const http = vi.fn(async () => new Response(JSON.stringify({
      ok: true, companyId: 1,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", http);
    render(<FinanceCompanyScopeCard />);
    expect(screen.getByText("PT CST")).toBeTruthy();
    expect(http).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {
      name: "Verifikasi perusahaan Finance",
    }));
    await waitFor(() => expect(http).toHaveBeenCalledOnce());
    await screen.findByText(/Perusahaan telah diverifikasi oleh server/);
    expect(http).toHaveBeenCalledWith(
      "/api/mkt/admin/finance-company-selection",
      expect.objectContaining({
        method: "POST", credentials: "include",
        body: JSON.stringify({ companyId: 1 }),
      }),
    );
  });

  it("describes signed Super Admin access without wrongly requiring OTP", () => {
    render(<FinanceCompanyScopeCard />);
    expect(screen.getByText(/sesi Super Admin yang sah/)).toBeTruthy();
    expect(screen.queryByText(/sesi OTP Super Admin/)).toBeNull();
  });

  it("disables selection when in all-company consolidated mode", () => {
    companyState.activeCompanyId = 0;
    companyState.isConsolidated = true;
    const http = vi.fn();
    vi.stubGlobal("fetch", http);
    render(<FinanceCompanyScopeCard />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(http).not.toHaveBeenCalled();
  });

  it("does not show server authorization as success after an HTTP 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("{}", { status: 403 })));
    render(<FinanceCompanyScopeCard />);
    fireEvent.click(screen.getByRole("button", {
      name: "Verifikasi perusahaan Finance",
    }));
    await screen.findByRole("alert");
    expect(screen.queryByText(/Perusahaan telah diverifikasi oleh server/)).toBeNull();
  });
});
