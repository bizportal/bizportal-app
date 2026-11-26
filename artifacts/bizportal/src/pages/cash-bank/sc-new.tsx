import { useEffect, useRef, useState } from "react";
import { Wallet, ArrowLeft, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompany } from "@/contexts/CompanyContext";

type Contra = { id:number; code:string; name:string };
type Readiness = {
  mode:string;
  account:{id:number;name:string;coaId:number;coaCode:string;openingBalance:string;createdAt:string};
  contraCandidates:Contra[];
  postingAllowed:false;
  historicalSheetConfig5:string;
};
type Preview = {
  mode:string;postingAllowed:false;amount:string;date:string;direction:"IN"|"OUT";
  proposedLines:Array<{coaId:number;coaCode:string;name:string;debit:string;credit:string}>;
  counterCoaClassification:string;reasons:string[];
};
const ENDPOINT="/api/cash-bank/sc-new";
const money=(s:string)=>new Intl.NumberFormat("id-ID",{
  minimumFractionDigits:2,maximumFractionDigits:2,
}).format(Number(s));
const localDate=()=>new Intl.DateTimeFormat("en-CA",{
  timeZone:"Asia/Jakarta",year:"numeric",month:"2-digit",day:"2-digit",
}).format(new Date());

export default function ScNewCashPreview() {
  const {activeCompanyId}=useCompany();
  const [readiness,setReadiness]=useState<Readiness|null>(null);
  const [preview,setPreview]=useState<Preview|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [date,setDate]=useState(localDate);
  const [direction,setDirection]=useState<"IN"|"OUT">("IN");
  const [amount,setAmount]=useState("");
  const [counterCoaId,setCounterCoaId]=useState("");
  const companyRequestVersion=useRef(0);

  useEffect(()=>{
    const controller=new AbortController();
    const version=++companyRequestVersion.current;
    setPreview(null);setReadiness(null);setError(null);setBusy(false);
    if(activeCompanyId!==1){
      setError("Khusus PT Cahaya Sejati Teknologi (Company #1), Account #18.");
      return ()=>controller.abort();
    }
    setLoading(true);
    void (async()=>{
      try{
        const response=await fetch(ENDPOINT+"/readiness?company_id=1",{
          credentials:"include",cache:"no-store",signal:controller.signal,
        });
        const payload=await response.json().catch(()=>null);
        if(!response.ok)throw Error(response.status===401
          ?"Diperlukan login OTP Owner/Super Admin yang sah."
          :"Pratinjau kas belum tersedia (HTTP "+response.status+").");
        if(payload?.account?.id!==18 || payload?.postingAllowed!==false
            || !Array.isArray(payload?.contraCandidates)
            || payload?.historicalSheetConfig5!=="NOT_USED_NONMIGRATION")
          throw Error("Respons keamanan pratinjau kas tidak sesuai.");
        if(!controller.signal.aborted && version===companyRequestVersion.current)
          setReadiness(payload as Readiness);
      }catch(err){
        if(!controller.signal.aborted && version===companyRequestVersion.current)
          setError(err instanceof Error?err.message:"Layanan pratinjau tidak tersedia.");
      }finally{
        if(!controller.signal.aborted && version===companyRequestVersion.current)
          setLoading(false);
      }
    })();
    return ()=>controller.abort();
  },[activeCompanyId]);

  const calculate=async()=>{
    if(activeCompanyId!==1 || !readiness || busy) return;
    const choice=readiness.contraCandidates.find(c=>String(c.id)===counterCoaId);
    if(!choice){setError("Pilih COA lawan kandidat terlebih dahulu.");return;}
    const version=companyRequestVersion.current;
    setPreview(null);setError(null);setBusy(true);
    try{
      const response=await fetch(ENDPOINT+"/preview",{
        method:"POST",credentials:"include",cache:"no-store",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({companyId:1,accountId:18,date,direction,
          amount,counterCoaId:choice.id}),
      });
      const payload=await response.json().catch(()=>null);
      if(version!==companyRequestVersion.current)return;
      if(!response.ok)throw Error("Validasi pratinjau ditolak (HTTP "+
        response.status+", "+String(payload?.code??"INVALID")+").");
      if(payload?.postingAllowed!==false || payload?.mode!=="READ_ONLY_IN_MEMORY_DRAFT"
          || !Array.isArray(payload?.proposedLines) || payload.proposedLines.length!==2)
        throw Error("Respons pratinjau tidak memenuhi pembatasan read-only.");
      setPreview(payload as Preview);
    }catch(err){
      if(version===companyRequestVersion.current)
        setError(err instanceof Error?err.message:"Tidak dapat menghitung pratinjau.");
    }finally{
      if(version===companyRequestVersion.current)setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={()=>window.history.back()} aria-label="Kembali" className="text-slate-400">
          <ArrowLeft size={19}/>
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Kas Besar SC — Pratinjau Transaksi Baru</h1>
          <p className="text-sm text-slate-400">Khusus CST DEV. Account #18, COA 1-1011-CST — bukan impor Sheet historis.</p>
        </div>
      </div>
      <Card className="border-amber-500/30 bg-amber-500/10">
        <CardContent className="flex gap-3 py-4 text-sm text-amber-100">
          <ShieldAlert className="shrink-0" size={18}/>
          <p>Hanya menghitung draft debit-kredit dalam memori. Belum ada verifikasi dokumen,
            persetujuan OTP untuk posting, maupun penulisan jurnal. Jangan anggap kandidat COA sebagai bukti akuntansi.</p>
        </CardContent>
      </Card>
      {error && <p role="alert" className="rounded-md border border-red-500/30 p-3 text-sm text-red-300">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Memeriksa sesi OTP dan akun kas...</p>}
      {readiness && (
        <Card className="bg-slate-800/90 text-white">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Wallet size={18}/> {readiness.account.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-300">
              COA {readiness.account.coaCode} · Saldo awal master Rp {money(readiness.account.openingBalance)}
              · {readiness.contraCandidates.length} kandidat COA aktif
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Arah kas</Label>
                <Select value={direction} onValueChange={v=>{
                  setDirection(v as "IN"|"OUT");setPreview(null);
                }}>
                  <SelectTrigger className="mt-1"><SelectValue/></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IN">Kas masuk (Debit Kas)</SelectItem>
                    <SelectItem value="OUT">Kas keluar (Kredit Kas)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Tanggal transaksi baru</Label>
                <DatePicker value={date} onChange={v=>{setDate(v);setPreview(null);}} className="mt-1"/>
              </div>
              <div>
                <Label>Nominal Rp (gunakan titik untuk desimal)</Label>
                <Input value={amount} inputMode="decimal" placeholder="150000.25"
                  onChange={e=>{setAmount(e.target.value);setPreview(null);}} className="mt-1"/>
              </div>
              <div>
                <Label>Calon COA lawan (belum diverifikasi dokumen)</Label>
                <Select value={counterCoaId} onValueChange={v=>{setCounterCoaId(v);setPreview(null);}}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Pilih COA kandidat"/></SelectTrigger>
                  <SelectContent>
                    {readiness.contraCandidates.map(c=>
                      <SelectItem key={c.id} value={String(c.id)}>{c.code} — {c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button type="button" onClick={()=>void calculate()}
              disabled={busy || loading || !counterCoaId || !amount.trim() || !date}>
              {busy?"Menghitung...":"Uji pratinjau saja (tanpa posting)"}
            </Button>
            <p className="text-xs text-slate-400">
              Tidak ada tombol Simpan, Setujui, atau Posting pada tahap ini.
              Sumber voucher UUID, dokumen asli, dan otorisasi posting harus diverifikasi oleh server.
            </p>
          </CardContent>
        </Card>
      )}
      {preview && (
        <Card className="bg-slate-800/90 text-white">
          <CardHeader><CardTitle className="text-base">Draft jurnal — tidak tersimpan</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-slate-600 text-slate-300">
                  <th className="py-2">COA</th><th>Akun</th>
                  <th className="text-right">Debit</th><th className="text-right">Kredit</th>
                </tr></thead>
                <tbody>{preview.proposedLines.map((line,index)=>
                  <tr key={index} className="border-b border-slate-700">
                    <td className="py-2">{line.coaCode}</td><td>{line.name}</td>
                    <td className="text-right tabular-nums">Rp {money(line.debit)}</td>
                    <td className="text-right tabular-nums">Rp {money(line.credit)}</td>
                  </tr>)}</tbody>
              </table>
            </div>
            <p role="status" className="text-sm text-amber-200">
              Pratinjau seimbang. Klasifikasi COA lawan belum dibuktikan dengan dokumen.
              Posting tetap DIBLOKIR.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
