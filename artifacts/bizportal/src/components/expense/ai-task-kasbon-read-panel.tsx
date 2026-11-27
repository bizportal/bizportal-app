import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useSupabaseAuth } from "@/contexts/SupabaseAuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type State = "APPROVED_NO_DISBURSEMENT" | "DISBURSEMENT_RECORDED" | "REFERENCE_REVIEW" | "CHECK_FINANCE_STATE";
type RecordRow = {
  advanceId: number; taskId: number | null; state: State;
  approvalRecorded: boolean; disbursementRecorded: boolean; journalReferenceRecorded: boolean;
};
type Result = { companyId: number; records: RecordRow[]; truncated: boolean };
const labels: Record<State, string> = {
  APPROVED_NO_DISBURSEMENT: "Disetujui — belum tercatat cair",
  DISBURSEMENT_RECORDED: "Tanggal pencairan tercatat",
  REFERENCE_REVIEW: "Perlu rekonsiliasi referensi",
  CHECK_FINANCE_STATE: "Perlu periksa status Finance",
};

export function AiTaskKasbonReadPanel() {
  const { user, isLoading } = useSupabaseAuth();
  const { activeCompanyId, isConsolidated } = useCompany();
  const enabled = typeof window !== "undefined" &&
    window.location.hostname === "dev-bizportal.cstlogistic.co.id" &&
    !isLoading && !!user && ["owner", "super_admin"].includes(String(user.role).toLowerCase()) &&
    activeCompanyId === 1 && !isConsolidated;
  const result = useQuery({
    queryKey: ["ai-task-kasbon-read", user?.id, user?.role, activeCompanyId],
    enabled, retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async (): Promise<Result> => {
      const response = await fetch("/api/advances/ai-task-reconciliation?companyId=1", {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) throw new Error("Finance belum tersedia untuk sesi ini.");
      const data = await response.json() as Result;
      if (data.companyId !== 1 || !Array.isArray(data.records)) throw new Error("Data Finance tidak valid.");
      return data;
    },
  });
  if (!enabled) return null;
  return <Card data-testid="ai-task-kasbon-read-panel">
    <CardHeader className="flex flex-row items-center justify-between gap-3">
      <CardTitle className="text-base">Rekonsiliasi Kasbon AI Task / GPT02</CardTitle>
      <Button type="button" size="sm" variant="outline" disabled={result.isFetching}
        onClick={() => void result.refetch()}>Refresh</Button>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        CST • baca-saja dari BizPortal. Hanya kasbon Finance dengan sumber persetujuan WA AI Task.
        Task tanpa referensi Finance tidak dianggap sebagai kasbon yang sudah disetujui atau dicairkan.
      </p>
      {result.isFetching || result.isPending ? <p>Memeriksa status Finance…</p> :
        result.isError || !result.data ? <p role="alert">Status Finance tidak tersedia untuk sesi ini. Tidak ada kesimpulan pencairan.</p> :
        <>
          <p className="text-xs text-muted-foreground">
            {result.data.records.length} catatan Finance ditampilkan{result.data.truncated ? " (100 terbaru; masih ada catatan lain)" : ""}.
            Tanggal pencairan dan referensi jurnal adalah penanda tercatat, bukan konfirmasi transfer bank atau posting jurnal.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b">
                <th className="py-2 pr-3">Task</th><th className="pr-3">Kasbon</th>
                <th className="pr-3">Status Finance</th><th className="pr-3">Persetujuan tercatat</th>
                <th className="pr-3">Tanggal cair</th><th>Referensi jurnal</th>
              </tr></thead>
              <tbody>
                {result.data.records.map(row => <tr key={row.advanceId} className="border-b">
                  <td className="py-2 pr-3">{row.taskId === null ? "Belum cocok unik" : "#" + row.taskId}</td>
                  <td className="pr-3">#{row.advanceId}</td>
                  <td className="pr-3">{labels[row.state] ?? "Perlu diperiksa"}</td>
                  <td className="pr-3">{row.approvalRecorded ? "Ada" : "Belum tercatat"}</td>
                  <td className="pr-3">{row.disbursementRecorded ? "Ada" : "Belum tercatat"}</td>
                  <td>{row.journalReferenceRecorded ? "Ada" : "Belum tercatat"}</td>
                </tr>)}
                {!result.data.records.length && <tr><td colSpan={6} className="py-4">Tidak ada catatan Finance dari sumber ini dalam lingkup CST.</td></tr>}
              </tbody>
            </table>
          </div>
        </>}
    </CardContent>
  </Card>;
}
