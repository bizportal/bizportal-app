import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AiTaskKasbonReadPanel } from "./ai-task-kasbon-read-panel";
import { useSupabaseAuth } from "@/contexts/SupabaseAuthContext";
import { useCompany } from "@/contexts/CompanyContext";

type HistoryRow = {
  id: number; advanceNumber: string | null; date: string | null; employeeName: string | null;
  category: string | null; recordedAmount: string | null; recordedPaidAmount: string | null;
  recordedRemainingAmount: string | null; legacyStatus: string | null; lifecycleStatus: string | null;
  postingStatus: string | null; approvalRecorded: boolean; disbursementRecorded: boolean;
  journalReferenceRecorded: boolean; state: string;
};
type History = { companyId: 1; readOnly: true; page: number; pageSize: 50; total: number; records: HistoryRow[] };
const labels: Record<string,string> = {
  VOID_RECORDED: "Void tercatat",
  APPROVED_NO_DISBURSEMENT: "Disetujui — belum tercatat cair",
  DISBURSEMENT_RECORDED: "Tanggal pencairan tercatat",
  WAITING_APPROVAL_RECORDED: "Menunggu persetujuan tercatat",
  CHECK_FINANCE_STATE: "Perlu periksa status Finance",
};
const money = (v: unknown) => {
  if (typeof v !== "string" || !/^\d+(?:\.\d+)?$/.test(v) || !Number.isFinite(Number(v))) return "—";
  return "Rp " + Number(v).toLocaleString("id-ID", {maximumFractionDigits: 2});
};
export function isDevCstKasbonHistoryScope(host: string, role: unknown, companyId: unknown, consolidated: boolean): boolean {
  return host === "dev-bizportal.cstlogistic.co.id" && companyId === 1 && !consolidated &&
    typeof role === "string" && ["owner","super_admin"].includes(role.toLowerCase());
}
export function DevCstKasbonHistoryPage() {
  const { user, isLoading } = useSupabaseAuth();
  const { activeCompanyId, isConsolidated } = useCompany();
  const [page, setPage] = useState(1);
  const enabled = !isLoading && !!user && isDevCstKasbonHistoryScope(window.location.hostname, user.role, activeCompanyId, isConsolidated);
  const query = useQuery({
    queryKey: ["dev-cst-kasbon-history", user?.id, user?.role, activeCompanyId, page],
    enabled, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async (): Promise<History> => {
      const response = await fetch("/api/advances/dev-kasbon-history?companyId=1&page="+page, {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw new Error("Kasbon history unavailable.");
      const value = await response.json() as History;
      if (value.companyId !== 1 || value.readOnly !== true || value.page !== page || value.pageSize !== 50 ||
          !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.records) ||
          value.records.length !== Math.min(50, Math.max(0, value.total - (page - 1)*50))) throw new Error("Invalid history.");
      return value;
    },
  });
  const data = query.isSuccess && !query.isFetching ? query.data : undefined;
  if (!enabled) return null;
  return <AppShell><div className="p-6 max-w-6xl mx-auto space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-bold">Kasbon Karyawan</h1>
        <p className="text-sm text-muted-foreground">CST-DEV · Riwayat baca-saja. Tidak ada tindakan pencairan, persetujuan, cicilan, atau posting.</p></div>
      <Link href="/expense/dana-karyawan" className="text-sm underline">Kembali ke Dana Karyawan</Link>
    </div>
    <AiTaskKasbonReadPanel />
    <Card data-testid="dev-cst-kasbon-history">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">Daftar Kasbon Karyawan Umum</CardTitle>
        <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={()=>void query.refetch()}>Refresh</Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">Semua catatan tipe kasbon karyawan dalam lingkup CST, termasuk void. Nominal, terbayar, dan sisa adalah nilai yang tersimpan, bukan saldo piutang atau pembayaran bank yang terverifikasi.</p>
        {query.isFetching || query.isPending ? <p>Memuat riwayat…</p> :
          !data ? <p role="alert">Daftar kasbon umum tidak dapat dimuat. Ini bukan berarti tidak ada kasbon.</p> :
          <>
            <p>{data.total} catatan tercatat · halaman {page}</p>
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead><tr className="border-b">
                <th className="py-2 pr-3">No. Kasbon</th><th className="pr-3">Tanggal</th><th className="pr-3">Karyawan</th>
                <th className="pr-3">Kategori</th><th className="pr-3">Nominal tercatat</th>
                <th className="pr-3">Terbayar tercatat</th><th className="pr-3">Sisa tercatat</th>
                <th>Status Finance</th>
              </tr></thead><tbody>
                {data.records.map(row=><tr key={row.id} className="border-b">
                  <td className="py-2 pr-3">{row.advanceNumber || "#"+row.id}</td>
                  <td className="pr-3 whitespace-nowrap">{row.date ?? "—"}</td>
                  <td className="pr-3">{row.employeeName ?? "Tidak ditemukan dalam CST"}</td>
                  <td className="pr-3">{row.category ?? "—"}</td>
                  <td className="pr-3 whitespace-nowrap">{money(row.recordedAmount)}</td>
                  <td className="pr-3 whitespace-nowrap">{money(row.recordedPaidAmount)}</td>
                  <td className="pr-3 whitespace-nowrap">{money(row.recordedRemainingAmount)}</td>
                  <td><span className="font-medium">{labels[row.state] ?? labels.CHECK_FINANCE_STATE}</span>
                    <span className="block text-xs text-muted-foreground">{row.lifecycleStatus ?? "—"} · {row.postingStatus ?? "—"}</span></td>
                </tr>)}
                {!data.records.length && <tr><td colSpan={8} className="py-5">{data.total===0 ? "Tidak ada catatan kasbon CST." : "Tidak ada catatan pada halaman ini."}</td></tr>}
              </tbody></table></div>
            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" disabled={page===1} onClick={()=>setPage(p=>p-1)}>Sebelumnya</Button>
              <Button type="button" variant="outline" size="sm" disabled={page*50>=data.total || page>=10000} onClick={()=>setPage(p=>p+1)}>Berikutnya</Button>
            </div>
          </>}
      </CardContent>
    </Card>
  </div></AppShell>;
}
