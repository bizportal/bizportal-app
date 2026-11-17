import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  companyId: 1,
  legacyList: vi.fn(),
  legacyJournals: vi.fn(),
  legacyPayment: vi.fn(),
}));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    activeCompanyId: state.companyId,
    activeCompany: { id: state.companyId, companyName: state.companyId === 1 ? "PT CST" : "PT DIVA" },
    isConsolidated: state.companyId === 0, isLoading: false,
  }),
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@shared/api-client-react", () => ({
  useListSalesDocuments: state.legacyList,
  useListJournals: state.legacyJournals,
  useCreateAccountingPayment: state.legacyPayment,
  getListSalesDocumentsQueryKey: () => ["/api/sales/documents"],
}));
vi.mock("@/contexts/LanguageContext", () => ({ useLanguage: () => ({ t: { common: {} } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/CorrespondenceTab", () => ({ CorrespondenceTab: () => null }));
vi.mock("@/components/ui/date-picker", () => ({ DatePicker: () => null }));
vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href?: string }) => <a href={href}>{children}</a>,
}));

import SalesInvoicesPage from "@/pages/sales/invoices";

const SCOPE_URL = "/api/mkt/admin/finance-company-selection";
const previewUrl = (id: number) => `/api/sales/customer-invoices/auto-match-preview?company_id=${id}`;
const clients: QueryClient[] = [];

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function preview(companyId = 1, reference = "INV-CST-001") {
  return {
    mode: "read_only_preview", autoApproveEnabled: false, autoPostEnabled: false, companyId,
    summary: { invoicedDocuments: 2, missingInvoiceNumbers: 1, missingPostedArEvidence: 1,
      unmatchedIncomingMutations: 1, suggestedExact: 1, requiresReview: 0 },
    matches: [{ mutationId: 100 + companyId, mutationAmount: 125_000,
      status: "candidate_ready_for_review", invoiceId: 50 + companyId,
      invoiceNumber: reference, reason: "Referensi dan sisa tagihan sesuai; perlu ditinjau." }],
  };
}
function zeroPreview(companyId = 1) {
  return { ...preview(companyId), summary: { invoicedDocuments: 0, missingInvoiceNumbers: 0,
    missingPostedArEvidence: 0, unmatchedIncomingMutations: 0, suggestedExact: 0, requiresReview: 0 }, matches: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const tree = () => <QueryClientProvider client={client}><SalesInvoicesPage /></QueryClientProvider>;
  const view = render(tree());
  return { switchCompany(id: number) { state.companyId = id; view.rerender(tree()); } };
}
function verifyCompany() {
  fireEvent.click(screen.getByRole("button", { name: "Verifikasi perusahaan Finance" }));
}
function stubReader(read: (companyId: number, init?: RequestInit) => Promise<Response> | Response) {
  const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === SCOPE_URL) {
      const selected = JSON.parse(String(init?.body)) as { companyId: number };
      return response({ ok: true, companyId: selected.companyId });
    }
    const match = String(input).match(/^\/api\/sales\/customer-invoices\/auto-match-preview\?company_id=([13])$/);
    if (!match) throw new Error("Unexpected non-preview request");
    return read(Number(match[1]), init);
  });
  vi.stubGlobal("fetch", http);
  return http;
}

beforeEach(() => {
  state.companyId = 1;
  state.legacyList.mockReset().mockReturnValue({ data: { data: [] } });
  state.legacyJournals.mockReset().mockReturnValue({ data: [] });
  state.legacyPayment.mockReset().mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  vi.stubEnv("VITE_BIZPORTAL_DEV_PASSWORD_ONLY", "true");
  vi.stubEnv("VITE_BIZPORTAL_FINANCE_GLOBAL_SCOPE_UI_DEV", "true");
  vi.stubEnv("VITE_BIZPORTAL_OTP_ONLY_PREVIEW", "false");
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("private Customer AR preview in the existing Sales Invoices page", () => {
  it("does not mount legacy list, journal or payment hooks; reads only after explicit Finance verification", async () => {
    const http = stubReader(id => response(preview(id)));
    mount();
    expect(screen.getByRole("heading", { name: "Invoice Pelanggan — Preview AR" })).toBeTruthy();
    expect(screen.getByText(/Maksimal 300 dokumen invoice dan 300 mutasi masuk/)).toBeTruthy();
    expect(http).not.toHaveBeenCalled();
    expect(state.legacyList).not.toHaveBeenCalled();
    expect(state.legacyJournals).not.toHaveBeenCalled();
    expect(state.legacyPayment).not.toHaveBeenCalled();
    expect(screen.queryByText("Belum ada invoice.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Bayar|WA|Konfirmasi Pembayaran/ })).toBeNull();
    verifyCompany();
    await screen.findByText("INV-CST-001");
    expect(http).toHaveBeenNthCalledWith(1, SCOPE_URL, expect.objectContaining({
      method: "POST", credentials: "include", body: JSON.stringify({ companyId: 1 }),
    }));
    expect(http).toHaveBeenNthCalledWith(2, previewUrl(1), expect.objectContaining({
      method: "GET", credentials: "include", cache: "no-store", signal: expect.any(AbortSignal),
    }));
    expect(http).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("region", { name: "Hasil preview invoice" })).toBeTruthy();
    expect(screen.getByText("Dokumen invoice diperiksa")).toBeTruthy();
    expect(screen.getByText("Cocok untuk ditinjau")).toBeTruthy();
  });

  it.each([404, 503])("shows an unavailable state, never a zero invoice claim, after HTTP %s", async status => {
    stubReader(() => response({ error: "unavailable" }, status));
    mount();
    verifyCompany();
    expect((await screen.findByRole("alert")).textContent).toContain("Jumlah invoice belum diketahui");
    expect(screen.queryByRole("region", { name: "Hasil preview invoice" })).toBeNull();
    expect(screen.queryByText(/Tidak ada dokumen berstatus invoice/)).toBeNull();
    expect(screen.queryByText("Belum ada invoice.")).toBeNull();
  });

  it("shows successful zero only after a complete valid response", async () => {
    const pending = deferred<Response>();
    stubReader(() => pending.promise);
    mount();
    expect(screen.queryByText(/Tidak ada dokumen berstatus invoice/)).toBeNull();
    verifyCompany();
    await screen.findByText("Memuat preview invoice perusahaan…");
    expect(screen.queryByRole("region", { name: "Hasil preview invoice" })).toBeNull();
    await act(async () => pending.resolve(response(zeroPreview())));
    expect(await screen.findByText("Tidak ada dokumen berstatus invoice pada perusahaan ini.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Hasil preview invoice" })).toBeTruthy();
  });

  it("clears old results during refresh and never turns a refresh failure into an empty list", async () => {
    const pending = deferred<Response>();
    let reads = 0;
    const http = stubReader(() => ++reads === 1 ? response(preview()) : pending.promise);
    mount(); verifyCompany();
    await screen.findByText("INV-CST-001");
    fireEvent.click(screen.getByRole("button", { name: "Perbarui preview" }));
    expect(screen.queryByText("INV-CST-001")).toBeNull();
    expect(screen.getByText("Memuat preview invoice perusahaan…")).toBeTruthy();
    await act(async () => pending.resolve(response({}, 503)));
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: "Hasil preview invoice" })).toBeNull();
    expect(http.mock.calls.filter(([url]) => String(url) === SCOPE_URL)).toHaveLength(1);
    expect(reads).toBe(2);
  });

  it("requires renewed company verification after403 and reads again after a successful confirmation", async () => {
    let reads = 0;
    const http = stubReader(() => ++reads === 1 ? response({}, 403) : response(preview()));
    mount(); verifyCompany();
    expect((await screen.findByRole("alert")).textContent).toContain("Verifikasi perusahaan Finance diperlukan");
    expect(screen.queryByText(/Perusahaan telah diverifikasi oleh server/)).toBeNull();
    expect((screen.getByRole("button", { name: "Perbarui preview" }) as HTMLButtonElement).disabled).toBe(true);
    verifyCompany();
    await screen.findByText("INV-CST-001");
    expect(http.mock.calls.filter(([url]) => String(url) === SCOPE_URL)).toHaveLength(2);
    expect(reads).toBe(2);
  });

  it("does not read financial data when the explicit company selection is denied", async () => {
    const http = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({}, 403));
    vi.stubGlobal("fetch", http);
    mount(); verifyCompany();
    await screen.findByText("Akun atau perusahaan ini belum diizinkan untuk Finance.");
    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith(SCOPE_URL, expect.objectContaining({ method: "POST" }));
    expect(screen.queryByRole("region", { name: "Hasil preview invoice" })).toBeNull();
  });

  it.each(["company", "mode", "approve", "post", "summary", "negative", "nonfinite", "unknown-status", "ready-without-invoice"])(
    "rejects a malformed successful %s response instead of displaying financial facts", async failure => {
      const body: Record<string, any> = preview();
      if (failure === "company") body.companyId = 3;
      if (failure === "mode") body.mode = "auto_post";
      if (failure === "approve") body.autoApproveEnabled = true;
      if (failure === "post") body.autoPostEnabled = true;
      if (failure === "summary") delete body.summary.missingPostedArEvidence;
      if (failure === "negative") body.summary.invoicedDocuments = -1;
      if (failure === "nonfinite") body.summary.invoicedDocuments = Infinity;
      if (failure === "unknown-status") body.matches[0].status = "approved";
      if (failure === "ready-without-invoice") { body.matches[0].invoiceId = null; body.matches[0].invoiceNumber = null; }
      stubReader(() => response(body));
      mount(); verifyCompany();
      expect((await screen.findByRole("alert")).textContent).toContain("Respons preview tidak sesuai");
      expect(screen.queryByRole("region", { name: "Hasil preview invoice" })).toBeNull();
      expect(screen.queryByText("INV-CST-001")).toBeNull();
    },
  );

  it("aborts and ignores a delayed CST preview after selecting DIVA", async () => {
    const old = deferred<Response>();
    let oldSignal: AbortSignal | undefined;
    stubReader((id, init) => {
      if (id === 1) { oldSignal = init?.signal as AbortSignal; return old.promise; }
      return response(preview(3, "INV-DIVA-003"));
    });
    const view = mount(); verifyCompany();
    await screen.findByText("Memuat preview invoice perusahaan…");
    view.switchCompany(3);
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: "Hasil preview invoice" })).toBeNull();
    verifyCompany();
    await screen.findByText("INV-DIVA-003");
    await act(async () => old.resolve(response(preview(1, "INV-OLD-CST"))));
    expect(screen.queryByText("INV-OLD-CST")).toBeNull();
    expect(screen.getByText("INV-DIVA-003")).toBeTruthy();
  });

  it("does not reuse a prior CST response on CST to DIVA to CST until fresh verification and GET", async () => {
    let cstReads = 0;
    stubReader(id => response(preview(id, id === 3 ? "INV-DIVA-003" : ++cstReads === 1 ? "INV-OLD-CST" : "INV-FRESH-CST")));
    const view = mount(); verifyCompany();
    await screen.findByText("INV-OLD-CST");
    view.switchCompany(3);
    expect(screen.queryByText("INV-OLD-CST")).toBeNull();
    verifyCompany(); await screen.findByText("INV-DIVA-003");
    view.switchCompany(1);
    expect(screen.queryByText("INV-OLD-CST")).toBeNull();
    expect(screen.queryByText("INV-DIVA-003")).toBeNull();
    expect(screen.getByText("Verifikasi perusahaan Finance untuk memuat preview invoice.")).toBeTruthy();
    expect(cstReads).toBe(1);
    verifyCompany(); await screen.findByText("INV-FRESH-CST");
    expect(cstReads).toBe(2);
  });

  it("ignores a delayed former-company scope confirmation without starting its financial GET", async () => {
    const oldScope = deferred<Response>();
    const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === SCOPE_URL) {
        const id = JSON.parse(String(init?.body)).companyId;
        return id === 1 ? oldScope.promise : response({ ok: true, companyId: 3 });
      }
      if (String(input) === previewUrl(3)) return response(preview(3, "INV-DIVA-003"));
      throw new Error("Former-company GET must not start");
    });
    vi.stubGlobal("fetch", http);
    const view = mount(); verifyCompany();
    await screen.findByText("Memverifikasi...");
    view.switchCompany(3); verifyCompany();
    await screen.findByText("INV-DIVA-003");
    await act(async () => oldScope.resolve(response({ ok: true, companyId: 1 })));
    expect(http.mock.calls.some(([url]) => String(url) === previewUrl(1))).toBe(false);
    expect(screen.getByText("INV-DIVA-003")).toBeTruthy();
  });

  it.each([0, 2])("does not read or verify an unsupported/consolidated company %s", companyId => {
    state.companyId = companyId;
    const http = vi.fn(); vi.stubGlobal("fetch", http);
    mount();
    expect(screen.getByText(/Pilih satu perusahaan CST atau DIVA/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verifikasi perusahaan Finance" })).toBeNull();
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    ["VITE_BIZPORTAL_DEV_PASSWORD_ONLY", "false"],
    ["VITE_BIZPORTAL_FINANCE_GLOBAL_SCOPE_UI_DEV", "false"],
    ["VITE_BIZPORTAL_OTP_ONLY_PREVIEW", "true"],
  ])("preserves the legacy page when private gate %s=%s", (flag, value) => {
    vi.stubEnv(flag, value);
    const http = vi.fn(); vi.stubGlobal("fetch", http);
    mount();
    expect(screen.getByRole("heading", { name: "Invoices Penjualan" })).toBeTruthy();
    expect(state.legacyList).toHaveBeenCalledWith({ kind: "order", limit: 500 });
    expect(state.legacyJournals).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Invoice Pelanggan — Preview AR" })).toBeNull();
    expect(http).not.toHaveBeenCalled();
  });
});
