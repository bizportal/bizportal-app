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
  const [receiptFile,setReceiptFile]=useState<File|null>(null);
  const [evidenceBusy,setEvidenceBusy]=useState(false);
  const [pendingEvidence,setPendingEvidence]=useState<{transactionId:string;status:"PENDING_VERIFICATION"}|null>(null);
  const companyRequestVersion=useRef(0);
  const draftRequestVersion=useRef(0);
  const invalidateDraft=()=>{
    draftRequestVersion.current++;
    setPreview(null);
    setReceiptFile(null);
    setPendingEvidence(null);
    setBusy(false);
  };

  useEffect(()=>{
    const controller=new AbortController();
    const version=++companyRequestVersion.current;
    draftRequestVersion.current++;
    setPreview(null);setReadiness(null);setError(null);setBusy(false);
    setReceiptFile(null);setPendingEvidence(null);
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
        const payload=await response.json().catch(()=>null) as Readiness | null;
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
    const draftVersion=++draftRequestVersion.current;
    setPreview(null);setError(null);setBusy(true);
    try{
      const response=await fetch(ENDPOINT+"/preview",{
        method:"POST",credentials:"include",cache:"no-store",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({companyId:1,accountId:18,date,direction,
          amount,counterCoaId:choice.id}),
      });
      const payload=await response.json().catch(()=>null) as (Preview & {code?:string}) | null;
      if(version!==companyRequestVersion.current || draftVersion!==draftRequestVersion.current)return;
      if(!response.ok)throw Error("Validasi pratinjau ditolak (HTTP "+
        response.status+", "+String(payload?.code??"INVALID")+").");
      if(payload?.postingAllowed!==false || payload?.mode!=="READ_ONLY_IN_MEMORY_DRAFT"
          || !Array.isArray(payload?.proposedLines) || payload.proposedLines.length!==2)
        throw Error("Respons pratinjau tidak memenuhi pembatasan read-only.");
      setPreview(payload as Preview);
    }catch(err){
      if(version===companyRequestVersion.current && draftVersion===draftRequestVersion.current)
        setError(err instanceof Error?err.message:"Tidak dapat menghitung pratinjau.");
    }finally{
      if(version===companyRequestVersion.current && draftVersion===draftRequestVersion.current)setBusy(false);
    }
  };

  const uploadPendingEvidence=async()=>{
    if(activeCompanyId!==1 || !preview || !receiptFile || evidenceBusy) return;
    if(receiptFile.size>8*1024*1024 || receiptFile.size<5){
      setError("Ukuran bukti harus lebih dari 0 dan maksimal 8 MB.");return;
    }
    const version=companyRequestVersion.current;
    const draftVersion=draftRequestVersion.current;
    setEvidenceBusy(true);setError(null);setPendingEvidence(null);
    try{
      const form=new FormData();
      form.append("companyId","1");
      form.append("accountId","18");
      form.append("date",preview.date);
      form.append("direction",preview.direction);
      form.append("amount",preview.amount);
      form.append("file",receiptFile,receiptFile.name);
      const response=await fetch(ENDPOINT+"/documents/pending",{
        method:"POST",credentials:"include",cache:"no-store",body:form,
      });
      const payload=await response.json().catch(()=>null) as ({
        mode?:string;transactionId?:string;status?:string;
        postingAllowed?:boolean;code?:string;
      })|null;
      if(version!==companyRequestVersion.current || draftVersion!==draftRequestVersion.current)return;
      if(response.status!==201 || payload?.mode!=="PENDING_PRIVATE_CASH_EVIDENCE_DEV" ||
          payload?.status!=="PENDING_VERIFICATION" || payload?.postingAllowed!==false ||
          typeof payload.transactionId!=="string")
        throw Error("Penyimpanan bukti belum berhasil (HTTP "+response.status+
          ", "+String(payload?.code??"INVALID")+").");
      setPendingEvidence({transactionId:payload.transactionId,status:"PENDING_VERIFICATION"});
      setReceiptFile(null);
    }catch(err){
      if(version===companyRequestVersion.current && draftVersion===draftRequestVersion.current)
        setError(err instanceof Error?err.message:"Penyimpanan bukti belum tersedia.");
    }finally{setEvidenceBusy(false);}
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
          <p>Pratinjau debit-kredit hanya dihitung dalam memori. File bukti baru dapat disimpan
            sebagai PENDING, tetapi belum ada verifikasi dokumen maupun persetujuan OTP untuk posting.
            Tidak ada penulisan jurnal atau impor Sheet historis.</p>
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
                  setDirection(v as "IN"|"OUT");invalidateDraft();
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
                <DatePicker value={date} onChange={v=>{setDate(v);invalidateDraft();}} className="mt-1"/>
              </div>
              <div>
                <Label>Nominal Rp (gunakan titik untuk desimal)</Label>
                <Input value={amount} inputMode="decimal" placeholder="150000.25"
                  onChange={e=>{setAmount(e.target.value);invalidateDraft();}} className="mt-1"/>
              </div>
              <div>
                <Label>Calon COA lawan (belum diverifikasi dokumen)</Label>
                <Select value={counterCoaId} onValueChange={v=>{setCounterCoaId(v);invalidateDraft();}}>
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
              Tidak ada tombol persetujuan atau posting jurnal. Penyimpanan file hanya menghasilkan
              bukti PENDING yang harus diverifikasi kembali oleh server dan Owner/Super Admin.
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
            <div className="space-y-2 rounded-md border border-slate-600 p-3">
              <Label htmlFor="sc-cash-evidence-file">File bukti transaksi baru (PDF/JPG/PNG/WebP, maksimal 8 MB)</Label>
              <input id="sc-cash-evidence-file" type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                disabled={evidenceBusy||!!pendingEvidence}
                onChange={e=>setReceiptFile(e.target.files?.[0]??null)}
                className="block w-full text-xs text-slate-300" />
              <Button type="button" variant="outline"
                onClick={()=>void uploadPendingEvidence()}
                disabled={evidenceBusy||!!pendingEvidence||!receiptFile||busy}>
                {evidenceBusy?"Menyimpan bukti...":"Simpan bukti PENDING (tanpa posting)"}
              </Button>
              {pendingEvidence && <p role="status" className="text-sm text-slate-100">
                Bukti baru tersimpan sebagai PENDING_VERIFICATION.
                ID transaksi: <code className="break-all">{pendingEvidence.transactionId}</code>.
                Belum ada verifikasi dokumen, persetujuan, atau posting keuangan.
              </p>}
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
