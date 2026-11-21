import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";

type Evidence = {
  code: string;
  evidenceLevel: string;
  verifiedAt: string;
  checks: { signedSuperAdmin: string; tenantRls: string; writeDenied: string };
  companies: Array<{ companyId: number; status: string; configCount: number }>;
  historicalMutationsPreserved: string;
  productionCutoverApproved: boolean;
};

export default function Pr147SuperAdminVerification() {
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function verify() {
    if (busy) return;
    setBusy(true);
    setEvidence(null);
    setFailure(null);
    try {
      const response = await fetch("/api/pr147/verify-super-admin", {
        method: "GET", credentials: "include", cache: "no-store",
      });
      const result = (await response.json()) as Partial<Evidence> & { code?: string };
      if (!response.ok || result.code !== "PR147_SIGNED_SUPER_ADMIN_READER_PASS") {
        setFailure(`Belum PASS (HTTP ${response.status}, ${result.code ?? "UNKNOWN"}). Tidak ada persetujuan rilis atau perubahan data.`);
        return;
      }
      setEvidence(result as Evidence);
    } catch {
      setFailure("API kandidat DEV tidak dapat dihubungi. Tidak ada transaksi yang dijalankan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <main className="mx-auto max-w-3xl space-y-6 p-6" data-testid="pr147-super-admin-verification">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Verifikasi Super Admin — BizPortal PR #147</h1>
          <p className="text-sm text-slate-500">
            Khusus DEV. Menggunakan sesi OTP BizPortal yang sudah login.
            Tidak meminta password, OTP atau cookie. Pemeriksaan hanya membaca data CST dan Diva.
          </p>
        </header>
        <section className="rounded-xl border border-slate-200 p-5 space-y-4">
          <p className="text-sm">Klik sekali untuk menguji sesi Super Admin yang asli, pembatasan perusahaan, RLS, dan hak baca-saja.</p>
          <button type="button" onClick={verify} disabled={busy}
            className="rounded-lg bg-indigo-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
            data-testid="pr147-verify-button">
            {busy ? "Memverifikasi…" : "Jalankan verifikasi baca-saja"}
          </button>
          {failure && <p role="alert" className="text-sm text-red-700">{failure}</p>}
          {evidence && (
            <div className="space-y-3 rounded-lg border border-slate-200 p-4" role="status">
              <h2 className="font-semibold text-emerald-700">PASS — sesi bertanda tangan dan pembaca database</h2>
              <p className="text-sm">Waktu: {new Date(evidence.verifiedAt).toLocaleString("id-ID")}</p>
              <ul className="space-y-1 text-sm">
                <li>Super Admin: {evidence.checks.signedSuperAdmin}</li>
                <li>RLS lintas perusahaan: {evidence.checks.tenantRls}</li>
                <li>Hak perubahan ditolak: {evidence.checks.writeDenied}</li>
                {evidence.companies.map(c => (
                  <li key={c.companyId}>
                    {c.companyId === 1 ? "CST" : "Diva"}: {c.status} — {c.configCount} konfigurasi terbaca
                  </li>
                ))}
              </ul>
              <p className="text-sm font-medium">Persetujuan cutover PROD: BELUM. Hasil ini bukan persetujuan otomatis.</p>
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
}
