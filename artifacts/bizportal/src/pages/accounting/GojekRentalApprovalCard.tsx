import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

type Account = { code: string; name: string; normalBalance: string; approvedBy: string | null; approvedAt: string | null };
type Approval = {
  sourceCompanyId: number; financeCompanyId: number;
  approvalEnabled: boolean; coasValid: boolean; approved: boolean;
  partiallyApproved: boolean; canApprove: boolean; postingEnabled: false;
  accounts: Account[];
  treatment: { deduction: string; rebate: string; tax: string };
};

const endpoint = "/api/accounting/gojek-rental-approval";

export function GojekRentalApprovalCard() {
  const qc = useQueryClient();
  const [confirmRentalRevenue, setRental] = useState(false);
  const [confirmDeductionClearing, setDeduction] = useState(false);
  const [confirmRebateAndTaxReview, setRebate] = useState(false);

  const query = useQuery<Approval>({
    queryKey: ["gojek-rental-diva-accounting-approval"],
    queryFn: async () => {
      const response = await fetch(endpoint, { credentials: "include", cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Pratinjau persetujuan belum tersedia.");
      return result;
    },
    retry: false,
    refetchOnWindowFocus: true,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCompanyId: 1, financeCompanyId: 3,
          confirmRentalRevenue, confirmDeductionClearing, confirmRebateAndTaxReview,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Persetujuan tidak tersimpan.");
      return result;
    },
    onSuccess: () => {
      toast.success("Persetujuan pemetaan Gojek berhasil disimpan.");
      void qc.invalidateQueries({ queryKey: ["gojek-rental-diva-accounting-approval"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const info = query.data;
  const canClick = Boolean(
    info?.canApprove && info.coasValid && !info.partiallyApproved &&
    confirmRentalRevenue && confirmDeductionClearing && confirmRebateAndTaxReview &&
    !mutation.isPending
  );
  return (
    <Card className="border-slate-700 bg-slate-900/60" data-testid="gojek-rental-approval-card">
      <CardHeader>
        <CardTitle className="text-base">Persetujuan Pemetaan Akuntansi Sewa Gojek — PT Diva Servis</CardTitle>
        <p className="text-sm text-slate-400">CST sumber Company 1 → Finance Diva Company 3. Persetujuan hanya melalui sesi OTP Super Admin. Tidak memposting jurnal atau uang masuk bank.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading && <p role="status">Memeriksa akun dan sesi persetujuan...</p>}
        {query.isError && <p role="alert" className="text-amber-300">Belum siap: {query.error.message}. Tombol tidak dapat digunakan sampai layanan DEV siap.</p>}
        {!info && <Button disabled data-testid="approve-gojek-rental-mapping">Setujui Pemetaan Akuntansi Gojek</Button>}
        {info && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-slate-400"><th>Kode COA</th><th>Nama akun</th><th>Saldo normal</th><th>Persetujuan</th></tr></thead>
                <tbody>{info.accounts.map(account => (
                  <tr className="border-t border-slate-700" key={account.code}>
                    <td className="py-2 font-mono">{account.code}</td>
                    <td>{account.name}</td><td>{account.normalBalance}</td>
                    <td>{account.approvedAt ? `Disetujui: ${account.approvedBy}` : "Belum disetujui"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {info.approved ? <p className="flex items-center gap-2 text-emerald-300"><CheckCircle2 size={16}/> Pemetaan sudah disetujui. Posting rental tetap dinonaktifkan sampai E2E PASS.</p> : (
              <>
                {info.partiallyApproved && <p role="alert" className="text-amber-300"><AlertTriangle size={16} className="inline"/> Status persetujuan sebagian; perlu pemeriksaan Finance sebelum dilanjutkan.</p>}
                <div className="space-y-3 text-sm">
                  <label className="flex items-start gap-2"><input type="checkbox" checked={confirmRentalRevenue} onChange={e=>setRental(e.target.checked)} className="mt-1"/> Saya memeriksa akun piutang driver dan pendapatan sewa kendaraan (bukan sewa tenant).</label>
                  <label className="flex items-start gap-2"><input type="checkbox" checked={confirmDeductionClearing} onChange={e=>setDeduction(e.target.checked)} className="mt-1"/> Saya memeriksa potongan GoPartner/Gojek sebagai kliring, bukan otomatis penerimaan bank.</label>
                  <label className="flex items-start gap-2"><input type="checkbox" checked={confirmRebateAndTaxReview} onChange={e=>setRebate(e.target.checked)} className="mt-1"/> Saya memahami rancangan rebate sebagai kontra pendapatan dan bahwa dasar PPN/pengembalian dana perlu validasi dokumen.</label>
                </div>
              </>
            )}
            <Button disabled={!canClick} onClick={()=>mutation.mutate()} data-testid="approve-gojek-rental-mapping">
              {mutation.isPending ? "Menyimpan persetujuan..." : info.approved ? "Sudah disetujui" : "Setujui Pemetaan Akuntansi Gojek"}
            </Button>
            {!info.approvalEnabled && <p className="text-xs text-amber-300">Persetujuan DEV belum diaktifkan pengembang; tombol tetap nonaktif.</p>}
            <p className="text-xs text-slate-400">Bukti persetujuan menyimpan akun, identitas Super Admin, dan tanggal persetujuan. Posting Finance PROD tetap OFF.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
