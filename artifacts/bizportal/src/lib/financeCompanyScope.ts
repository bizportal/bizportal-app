/**
 * Presentation-layer request for a Finance company selection.
 * This does not authorize the company: the server verifies the signed Super
 * Admin session, allowlisted live company, and selected Finance mode.
 */
export function isSelectableFinanceCompanyId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export type FinanceScopeConfirmation = { ok: true; companyId: number };

export async function requestFinanceCompanyScope(
  companyId: number,
  http: typeof fetch = fetch,
): Promise<FinanceScopeConfirmation> {
  if (!isSelectableFinanceCompanyId(companyId)) {
    throw new Error("Pilih satu perusahaan yang valid, bukan Semua Perusahaan.");
  }
  const response = await http("/api/mkt/admin/finance-company-selection", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyId }),
  });

  if (!response.ok) {
    switch (response.status) {
      case 401:
        throw new Error("Login ulang sebagai Super Admin untuk menggunakan Finance.");
      case 403:
        throw new Error("Akun atau perusahaan ini belum diizinkan untuk Finance.");
      case 404:
        throw new Error("Pemilihan perusahaan Finance belum diaktifkan pada DEV.");
      case 422:
        throw new Error("Pilihan perusahaan tidak valid.");
      default:
        throw new Error("Verifikasi perusahaan Finance gagal. Silakan coba lagi.");
    }
  }
  const result = await response.json().catch(() => null) as {
    ok?: unknown; companyId?: unknown;
  } | null;
  if (result?.ok !== true || result.companyId !== companyId) {
    throw new Error("Server tidak mengonfirmasi perusahaan Finance yang dipilih.");
  }
  return { ok: true, companyId };
}
