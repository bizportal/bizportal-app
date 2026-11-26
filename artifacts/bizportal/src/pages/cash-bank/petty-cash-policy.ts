/** UI safety only. The accounting writer must independently authorize every operation. */
export type CashAccountChoice = {
  id: number | string;
  is_active: boolean;
  account_type?: string | null;
};
export function isPettyCashChoice(account: CashAccountChoice, companyId: number | null): boolean {
  const accountType = String(account.account_type ?? "").toLowerCase();
  const supported = accountType === "cash" || accountType === "petty_cash";
  // CST Account18 is Kas Besar SC, not the petty-cash workflow.
  return Boolean(account.is_active) && supported &&
    !(companyId === 1 && Number(account.id) === 18);
}
export function pettyCashReadError(status: number): string {
  if (status === 404) return "Layanan transaksi Kas Kecil belum tersedia pada API ini. Pembuatan transaksi dinonaktifkan.";
  if (status === 401 || status === 403) return "Sesi atau izin akses Kas Kecil tidak sah. Tidak ada transaksi yang disimpan.";
  return `Layanan transaksi Kas Kecil tidak dapat dibaca (HTTP ${status}). Tidak ada transaksi yang disimpan.`;
}
