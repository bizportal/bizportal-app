import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSupabaseAuth } from "@/contexts/SupabaseAuthContext";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AiTaskKasbonReadPanel } from "@/components/expense/ai-task-kasbon-read-panel";
import { canReadCstDevKasbon, parseDevKasbonPage, formatRecordedKasbonAmount } from "@/lib/dev-kasbon-general-read";

export function DevKasbonGeneralReadPage() {
  const { user, isLoading }=useSupabaseAuth();
  const [page,setPage]=useState(1);
  const enabled=!isLoading && !!user && canReadCstDevKasbon(user.role);
  const result=useQuery({
    queryKey:["dev-cst-kasbon-general-read",user?.id,user?.role,page],
    enabled,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:false,
    queryFn:async()=>{
      const response=await fetch("/api/advances/dev-kasbon-list?companyId=1&page="+page,{
        credentials:"include",cache:"no-store",
      });
      if(!response.ok)throw Error("Data kasbon tidak tersedia.");
      return parseDevKasbonPage(await response.json(),page);
    },
  });
  const data=enabled && result.isSuccess ? result.data : undefined;
  return <AppShell><div className="p-6 space-y-5 max-w-5xl mx-auto" data-testid="dev-kasbon-general-read-page">
    <div className="flex flex-wrap justify-between items-center gap-3">
      <div><h1 className="text-xl font-bold">Kasbon Karyawan</h1>
        <p className="text-sm text-muted-foreground">CST • DEV • baca-saja</p></div>
      <Link href="/expense/dana-karyawan" className="text-sm underline">Dana Karyawan</Link>
    </div>
    <p className="text-sm text-muted-foreground">Daftar Finance tercatat, bukan bukti saldo piutang terverifikasi. Pembuatan, persetujuan, pencairan, pembayaran dan posting tidak tersedia pada pembaca ini.</p>
    <AiTaskKasbonReadPanel />
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">Daftar kasbon umum — CST</CardTitle>
        <Button size="sm" variant="outline" disabled={!enabled||result.isFetching} onClick={()=>void result.refetch()}>Refresh</Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? <p>Memeriksa sesi...</p> : !enabled ?
          <p role="alert">Pembacaan memerlukan sesi Owner atau Super Admin BizPortal yang sah.</p> :
          result.isPending ? <p>Memuat kasbon...</p> : !data ?
          <p role="alert">Daftar kasbon umum tidak dapat dimuat. Ini bukan berarti tidak ada kasbon.</p> :
          <>
            <p className="text-muted-foreground">{data.total} catatan kasbon tercatat. Halaman {page} • maks. 50 per halaman. Nominal, pembayaran, sisa dan status ditampilkan sebagaimana tercatat, bukan konfirmasi pencairan atau jurnal.</p>
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead><tr className="border-b"><th>No. Kasbon</th><th>Tanggal</th><th>Karyawan</th>
                <th>Nominal tercatat</th><th>Terbayar tercatat</th><th>Sisa tercatat</th><th>Status / posting</th><th>Bukti tercatat</th></tr></thead>
              <tbody>
                {data.records.map(row=><tr key={row.id} className="border-b">
                  <td className="py-2 pr-3">{row.advanceNumber??"#"+row.id}</td><td className="pr-3">{row.date??"—"}</td>
                  <td className="pr-3">{row.employeeName??"Belum cocok"}</td>
                  <td className="pr-3 whitespace-nowrap">{formatRecordedKasbonAmount(row.amountRecorded)}</td>
                  <td className="pr-3 whitespace-nowrap">{formatRecordedKasbonAmount(row.paidRecorded)}</td>
                  <td className="pr-3 whitespace-nowrap">{formatRecordedKasbonAmount(row.remainingRecorded)}</td>
                  <td className="pr-3">{row.lifecycleStatus??row.status??"—"}<span className="block text-xs text-muted-foreground">{row.postingStatus??"Belum tercatat"}</span></td>
                  <td className="text-xs">Persetujuan: {row.approvalRecorded?"Ada":"Belum tercatat"}<span className="block">Tanggal cair: {row.disbursementRecorded?"Ada":"Belum tercatat"}</span><span className="block">Referensi jurnal: {row.journalReferenceRecorded?"Ada":"Belum tercatat"}</span></td>
                </tr>)}
                {!data.records.length&&<tr><td colSpan={8} className="py-4">{data.total===0?"Belum ada catatan kasbon dalam lingkup CST.":"Halaman ini tidak memiliki catatan. Kembali ke halaman sebelumnya."}</td></tr>}
              </tbody>
            </table></div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="outline" size="sm" disabled={page<=1||result.isFetching} onClick={()=>setPage(p=>Math.max(1,p-1))}>Sebelumnya</Button>
              <Button variant="outline" size="sm" disabled={page>=10000||page*50>=data.total||result.isFetching} onClick={()=>setPage(p=>Math.min(10000,p+1))}>Berikutnya</Button>
            </div>
          </>}
      </CardContent>
    </Card>
  </div></AppShell>;
}
