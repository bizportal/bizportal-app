import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const fixture = vi.hoisted(() => ({ companyId: 1, anonymous: false, scopeRequired: false,
  verified: false, posts: 0, result: null as any, invalid: false, failed: false }));
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/contexts/CompanyContext", () => ({ useCompany: () => ({ activeCompanyId: fixture.companyId }) }));
vi.mock("@/pages/purchase/FinanceCompanyScopeCard", () => ({
  FinanceCompanyScopeCard: () => <div>Verifikasi perusahaan Finance (DEV)</div>,
}));
vi.mock("wouter", () => ({ Link: ({ children, href }: any) => <a href={href}>{children}</a> }));
import Page from "@/pages/finance/po14-e2e-qa";
const mockResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
function receipt() {
  return {
    id: "32570381-3fdf-4dc3-90cf-dc69468bd908", reference: "PO-20261117-00014", companyId: 1,
    actor: "owner@qa.invalid", amount: "100000.00", auditCount: 1,
    createdAt: "2026-11-25T10:30:00Z", workerSha256: "a".repeat(64),
    evidence: {
      ok: true, contract: "po14-real-sql-v1", reference: "PO-20261117-00014",
      runId: "32570381-3fdf-4dc3-90cf-dc69468bd908",
      actor: { email: "owner@qa.invalid", companyId: 1 },
      entities: { invoiceId: 11, apId: 12, requestId: 13, handoffId: 14, mutationId: 15,
        matchId: 16, groupId: 17, allocationId: 18, journalId: 19 },
      totals: { debit: "100000.00", credit: "100000.00" },
      checks: { invoiceCreated: true, threeWayMatched: true, apPrepared: true,
        paymentApproved: true, bankImported: true, automaticMatched: true,
        allocationCreated: true, journalPosted: true, paymentFinalized: true,
        replayIdempotent: true, auditRollback: true },
      auditCounts: { approval: 1, bank: 1, finalization: 1 },
      isolatedDatabase: { name: "po14_bank_ingestion_qa_0123456789ab", removed: true },
      outboundNotifications: 0, sheetTransport: "synthetic_fixture",
      businessDatabaseUsed: false, realBankTransfer: false,
    },
  };
}
const payload = (replay = false) => ({ contractVersion: 2, sandbox: true, bankTransfer: false,
  businessLedgerPosted: false, sheetTransport: "synthetic_fixture", result: fixture.result, replay });
describe("PO14 page renders actual isolated service evidence only", () => {
  beforeEach(() => {
    fixture.companyId = 1; fixture.anonymous = false; fixture.scopeRequired = false;
    fixture.verified = false; fixture.posts = 0; fixture.result = null; fixture.invalid = false; fixture.failed = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/mkt/admin/finance-company-selection") {
        fixture.verified = true; return mockResponse({ ok: true, companyId: 1 });
      }
      if (url !== "/api/mkt/admin/po14-e2e-qa") throw Error("Unexpected URL");
      if (fixture.anonymous) return mockResponse({ error: "Sesi Super Admin diperlukan" }, 401);
      if (fixture.scopeRequired && !fixture.verified) return mockResponse({ error: "Finance scope" }, 403);
      let replay = false;
      if (options?.method === "POST") {
        fixture.posts++;
        expect(JSON.parse(String(options.body))).toEqual({ reference: "PO-20261117-00014" });
        if (fixture.failed) return mockResponse({ error: "Pengujian SQL belum berhasil diverifikasi. Tidak ada hasil PASS baru." }, 503);
        replay = fixture.result !== null;
        fixture.result = receipt();
        if (fixture.invalid) fixture.result.evidence.checks.automaticMatched = false;
      }
      return mockResponse(payload(replay));
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it("shows real entity evidence, balanced debit/credit and the source transport boundary", async () => {
    render(<Page />);
    const button = await screen.findByRole("button", { name: "Jalankan Uji Transaksi PO #14" });
    expect(document.body.textContent).toContain("Koneksi Google Sheets dan transfer bank sungguhan tidak termasuk");
    expect(screen.queryByText("PASS")).toBeNull();
    fireEvent.click(button);
    await screen.findByText("PASS — transaksi SQL terisolasi terverifikasi");
    expect(fixture.posts).toBe(1);
    expect(screen.getByText("Debit Rp100.000 = kredit Rp100.000")).toBeTruthy();
    expect(screen.getByText(/Mutasi #15 · Match #16/)).toBeTruthy();
    expect(screen.getByText(/Jurnal #19/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Periksa Bukti Tersimpan" }));
    await screen.findByText("Bukti tersimpan diperiksa ulang; tidak membuat transaksi uji tambahan.");
  });
  it("recovers verified CST scope using the existing selection endpoint", async () => {
    fixture.scopeRequired = true; render(<Page />);
    expect(await screen.findByRole("button", { name: "Jalankan Uji Transaksi PO #14" })).toBeTruthy();
    expect(fixture.verified).toBe(true);
  });
  it("never offers the action for an anonymous browser", async () => {
    fixture.anonymous = true; render(<Page />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Jalankan Uji Transaksi PO #14" })).toBeNull();
    expect(fixture.posts).toBe(0);
  });
  it("ignores stale failed GET after a newer authenticated GET succeeds", async () => {
    let settleFirst: ((response: any) => void) | null = null;
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url !== "/api/mkt/admin/po14-e2e-qa") throw Error("Unexpected URL");
      calls++;
      if (calls === 1) return new Promise(resolve => { settleFirst = resolve; });
      return mockResponse(payload());
    }));
    render(<React.StrictMode><Page /></React.StrictMode>);
    await screen.findByText("Belum ada bukti transaksi SQL untuk versi layanan ini.");
    expect(calls).toBeGreaterThanOrEqual(2);
    (settleFirst as unknown as (v: any) => void)(mockResponse({ error: "Old scope request failed" }, 503));
    await screen.findByText("Perusahaan Finance CST telah diverifikasi oleh server untuk sesi ini.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Jalankan Uji Transaksi PO #14" })).toBeTruthy();
  });
  it("hides CST execution when another company is selected", async () => {
    fixture.companyId = 3; render(<Page />);
    await screen.findByText("Verifikasi perusahaan Finance (DEV)");
    expect(screen.queryByRole("button", { name: "Jalankan Uji Transaksi PO #14" })).toBeNull();
  });
  it("rejects a legacy SIMULATED receipt instead of upgrading its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse({ sandbox: true, bankTransfer: false,
      businessLedgerPosted: false, result: { status: "completed", steps: [{ status: "SIMULATED" }] } })));
    render(<Page />);
    expect((await screen.findByRole("alert")).textContent).toContain("kontrak simulasi lama");
    expect(screen.queryByRole("button", { name: "Jalankan Uji Transaksi PO #14" })).toBeNull();
    expect(screen.queryByText("PASS")).toBeNull();
  });
  it("refuses a success response missing actual automatic matching evidence", async () => {
    fixture.invalid = true; render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "Jalankan Uji Transaksi PO #14" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Bukti layanan SQL tidak lengkap");
    expect(screen.queryByText("PASS — transaksi SQL terisolasi terverifikasi")).toBeNull();
  });
  it("shows a failed worker result without presenting a success stage", async () => {
    fixture.failed = true; render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "Jalankan Uji Transaksi PO #14" }));
    expect((await screen.findByRole("alert")).textContent).toContain("belum berhasil diverifikasi");
    expect(screen.queryByText("PASS — transaksi SQL terisolasi terverifikasi")).toBeNull();
  });
});
