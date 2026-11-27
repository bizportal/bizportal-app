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

type PendingCashAcknowledgement = { transactionId:string;status:"PENDING_VERIFICATION" };
type ServerPendingDocument = PendingCashAcknowledgement & {
  date:string;direction:"IN"|"OUT";amount:string;
};
const COMPANY1_PENDING_ACK_KEY="cst.account18.pending.evidence.ack.v1";
function loadCompany1PendingAcknowledgement():PendingCashAcknowledgement|null{
  if(typeof window==="undefined")return null;
  try{
    const raw=window.sessionStorage.getItem(COMPANY1_PENDING_ACK_KEY);
    if(!raw)return null;
    const parsed=JSON.parse(raw) as Partial<PendingCashAcknowledgement>;
    if(parsed.status!=="PENDING_VERIFICATION" || typeof parsed.transactionId!=="string" ||
       !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(parsed.transactionId))
      return null;
    return {transactionId:parsed.transactionId,status:"PENDING_VERIFICATION"};
  }catch{return null;}
}

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
  const [pendingEvidence,setPendingEvidence]=useState<PendingCashAcknowledgement|null>(loadCompany1PendingAcknowledgement);
  const [serverPendingDocuments,setServerPendingDocuments]=useState<ServerPendingDocument[]>([]);
  const [pendingListError,setPendingListError]=useState(false);
  const [integrityBusy,setIntegrityBusy]=useState(false);
  const [integrityResult,setIntegrityResult]=useState<"MATCH"|"UNAVAILABLE"|null>(null);
  const [reviewedUpload,setReviewedUpload]=useState<{transactionId:string;file:File}|null>(null);
  const [verifiedId,setVerifiedId]=useState<string|null>(null);
  const companyRequestVersion=useRef(0);
  const draftRequestVersion=useRef(0);
  const invalidateDraft=()=>{
    draftRequestVersion.current++;
    setPreview(null);
    setReceiptFile(null);
    setBusy(false);
  };

  useEffect(()=>{
    const controller=new AbortController();
    const version=++companyRequestVersion.current;
    draftRequestVersion.current++;
    setPreview(null);setReadiness(null);setError(null);setBusy(false);
    setReceiptFile(null); // Preserve Company #1 acknowledgement across company changes.
    setServerPendingDocuments([]);
    setPendingListError(false);
    setIntegrityResult(null);
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
        // Read the server-owned registry after the signed Owner readiness check.
        // Local sessionStorage UUID alone is never an authorization source.
        try{
          const recordsResponse=await fetch(ENDPOINT+"/documents/pending",{
            credentials:"include",cache:"no-store",signal:controller.signal,
          });
          const records=await recordsResponse.json().catch(()=>null) as ({
            mode?:string;companyId?:number;accountId?:number;postingAllowed?:boolean;
            historicalSheetConfig5?:string;documents?:ServerPendingDocument[];
          })|null;
          if(!recordsResponse.ok || records?.mode!=="ACCOUNT18_PENDING_SERVER_RECORDS" ||
              records.companyId!==1 || records.accountId!==18 ||
              records.postingAllowed!==false ||
              records.historicalSheetConfig5!=="NOT_USED_NONMIGRATION" ||
              !Array.isArray(records.documents))throw Error("PENDING_LIST_UNAVAILABLE");
          const valid=records.documents.filter(d=>
            d?.status==="PENDING_VERIFICATION" &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(d.transactionId) &&
            /^\d{4}-\d{2}-\d{2}$/.test(d.date) &&
            (d.direction==="IN"||d.direction==="OUT") &&
            /^\d+\.\d{2}$/.test(d.amount)
          ).slice(0,20);
          if(!controller.signal.aborted && version===companyRequestVersion.current)
            setServerPendingDocuments(valid);
        }catch{
          if(!controller.signal.aborted && version===companyRequestVersion.current)
            setPendingListError(true);
        }
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
    if(activeCompanyId!==1 || !readiness || busy || evidenceBusy || !!pendingEvidence) return;
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
    setEvidenceBusy(true);setError(null);
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
      // Do not discard a successful server write when the global CompanySwitcher changes.
      // Editing is locked during upload. Preserve successful server receipt even if
      // an unrelated preview request changed its local version.
      if(response.status!==201 || payload?.mode!=="PENDING_PRIVATE_CASH_EVIDENCE_DEV" ||
          payload?.status!=="PENDING_VERIFICATION" || payload?.postingAllowed!==false ||
          typeof payload.transactionId!=="string")
        throw Error("Penyimpanan bukti belum berhasil (HTTP "+response.status+
          ", "+String(payload?.code??"INVALID")+").");
      const ack:PendingCashAcknowledgement={
        transactionId:payload.transactionId,status:"PENDING_VERIFICATION",
      };
      // UI-only receipt recovery; never trust this state as financial authorization.
      try{window.sessionStorage.setItem(COMPANY1_PENDING_ACK_KEY,JSON.stringify(ack));}
      catch{/* Keep the successful receipt visible in component state. */}
      setPendingEvidence(ack);
      setReviewedUpload({transactionId:ack.transactionId,file:receiptFile});
      setIntegrityResult(null);
      if(version===companyRequestVersion.current)setReceiptFile(null);
    }catch(err){
      if(version===companyRequestVersion.current && draftVersion===draftRequestVersion.current)
        setError(err instanceof Error?err.message:"Penyimpanan bukti belum tersedia.");
    }finally{setEvidenceBusy(false);}
  };

  const checkPendingIntegrity=async()=>{
    if(activeCompanyId!==1 || !readiness || !pendingEvidence || integrityBusy || evidenceBusy)return;
    const id=pendingEvidence.transactionId;
    const version=companyRequestVersion.current;
    setIntegrityBusy(true);
    setIntegrityResult(null);
    try{
      const response=await fetch(ENDPOINT+"/documents/"+encodeURIComponent(id)+"/integrity",{
        method:"GET",credentials:"include",cache:"no-store",
      });
      const payload=await response.json().catch(()=>null) as ({
        transactionId?:string;status?:string;storageIntegrity?:string;
        documentApproval?:string;postingAllowed?:boolean;
        historicalSheetConfig5?:string;
      })|null;
      if(version!==companyRequestVersion.current)return;
      if(response.ok && payload?.transactionId===id &&
          payload.status==="PENDING_VERIFICATION" &&
          payload.storageIntegrity==="MATCH" &&
          payload.documentApproval==="NOT_VERIFIED" &&
          payload.postingAllowed===false &&
          payload.historicalSheetConfig5==="NOT_USED_NONMIGRATION"){
        setIntegrityResult("MATCH");
      }else{
        setIntegrityResult("UNAVAILABLE");
      }
    }catch{
      if(version===companyRequestVersion.current)setIntegrityResult("UNAVAILABLE");
    }finally{setIntegrityBusy(false);}
  };

  const verifyEvidence=async()=>{
    if(activeCompanyId!==1 || !readiness || !pendingEvidence || evidenceBusy || integrityBusy || integrityResult!=="MATCH" ||
       reviewedUpload?.transactionId!==pendingEvidence.transactionId ||
       verifiedId===pendingEvidence.transactionId)return;
    if(!window.confirm("Konfirmasi bahwa Anda telah memeriksa bukti asli yang baru diunggah, nominal dan tanggalnya. Verifikasi ini bukan persetujuan posting."))return;
    const id=pendingEvidence.transactionId;
    const version=companyRequestVersion.current;
    setEvidenceBusy(true);setError(null);
    try{
      const response=await fetch(ENDPOINT+"/documents/verify",{
        method:"POST",credentials:"include",cache:"no-store",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({companyId:1,accountId:18,transactionId:id,confirmed:true}),
      });
      const payload=await response.json().catch(()=>null);
      if(response.status!==201 || payload?.transactionId!==id ||
         payload?.status!=="VERIFIED" || payload?.postingAllowed!==false)
        throw Error("Verifikasi belum berhasil (HTTP "+response.status+").");
      setVerifiedId(id);setIntegrityResult(null);
    }catch(err){
      if(version===companyRequestVersion.current)
        setError(err instanceof Error?err.message:"Verifikasi belum tersedia.");
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
            sebagai PENDING dan dapat diverifikasi oleh Owner. Persetujuan OTP untuk posting belum tersedia.
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
                <Select value={direction} disabled={evidenceBusy||!!pendingEvidence} onValueChange={v=>{
                  if(evidenceBusy)return;
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
                <DatePicker value={date} disabled={evidenceBusy||!!pendingEvidence} onChange={v=>{if(evidenceBusy)return;setDate(v);invalidateDraft();}} className="mt-1"/>
              </div>
              <div>
                <Label>Nominal Rp (gunakan titik untuk desimal)</Label>
                <Input value={amount} inputMode="decimal" placeholder="150000.25"
                  disabled={evidenceBusy||!!pendingEvidence} onChange={e=>{if(evidenceBusy||pendingEvidence)return;setAmount(e.target.value);invalidateDraft();}} className="mt-1"/>
              </div>
              <div>
                <Label>Calon COA lawan (belum diverifikasi dokumen)</Label>
                <Select value={counterCoaId} disabled={evidenceBusy||!!pendingEvidence} onValueChange={v=>{if(evidenceBusy)return;setCounterCoaId(v);invalidateDraft();}}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Pilih COA kandidat"/></SelectTrigger>
                  <SelectContent>
                    {readiness.contraCandidates.map(c=>
                      <SelectItem key={c.id} value={String(c.id)}>{c.code} — {c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button type="button" onClick={()=>void calculate()}
              disabled={busy || evidenceBusy || !!pendingEvidence || loading || !counterCoaId || !amount.trim() || !date}>
              {busy?"Menghitung...":"Uji pratinjau saja (tanpa posting)"}
            </Button>
            <p className="text-xs text-slate-400">
              Tidak ada tombol persetujuan atau posting jurnal. Penyimpanan file hanya menghasilkan
              bukti PENDING yang harus diverifikasi kembali oleh server dan Owner/Super Admin.
            </p>
          </CardContent>
        </Card>
      )}
      {readiness && activeCompanyId===1 && (
        <Card className="border-sky-500/30 bg-slate-800/90 text-white">
          <CardHeader><CardTitle className="text-base">Dokumen PENDING tersimpan di server</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-slate-300">
              Dokumen berasal dari database CST-DEV, bukan riwayat tab browser.
              Pilih dokumen untuk melakukan audit byte tanpa unggah ulang.
            </p>
            {serverPendingDocuments.length===0 && <p role="status" className="text-sm text-slate-300">
              {pendingListError?"Daftar dokumen belum dapat diambil dari server.":
              "Tidak ada dokumen PENDING yang ditemukan dalam daftar terbaru."}
            </p>}
            {serverPendingDocuments.map(doc=><div key={doc.transactionId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-600 p-3">
              <div className="text-sm">
                <p className="font-mono break-all">{doc.transactionId}</p>
                <p className="text-slate-300">{doc.date} · {doc.direction==="IN"?"Kas masuk":"Kas keluar"} · Rp {money(doc.amount)}</p>
              </div>
              <Button type="button" variant="outline" disabled={evidenceBusy||integrityBusy}
                onClick={()=>{
                  setPendingEvidence({transactionId:doc.transactionId,status:"PENDING_VERIFICATION"});
                  setIntegrityResult(null);setReviewedUpload(null);setVerifiedId(null);
                  setPreview(null);
                }}>Buka audit dokumen</Button>
            </div>)}
          </CardContent>
        </Card>
      )}
      {readiness && pendingEvidence && activeCompanyId===1 && (
        <Card className="border-sky-500/40 bg-slate-800/90 text-white">
          <CardContent className="space-y-2 py-4">
            <p role="status" className="text-sm">
              {verifiedId===pendingEvidence.transactionId?"Bukti VERIFIED oleh server (belum disetujui untuk posting).":"Bukti tersimpan sebagai PENDING_VERIFICATION (belum disetujui)."}
              ID transaksi: <code className="break-all">{pendingEvidence.transactionId}</code>.
              Tidak ada jurnal keuangan yang diposting.
            </p>
            <Button type="button" variant="outline"
              disabled={integrityBusy||evidenceBusy||verifiedId===pendingEvidence.transactionId}
              onClick={()=>void checkPendingIntegrity()}>
              {integrityBusy?"Memeriksa byte dokumen...":"Periksa integritas PDF (baca-saja)"}
            </Button>
            <a
              href={ENDPOINT+"/documents/"+encodeURIComponent(pendingEvidence.transactionId)+"/download"}
              className="inline-flex min-h-9 items-center rounded-md border border-slate-500 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700"
            >Unduh bukti asli untuk diperiksa (Owner)</a>
            <p className="text-xs text-slate-300">
              File akan diunduh dari server privat setelah otorisasi ulang. Periksa isi
              dokumen secara manual sebelum memverifikasi; unduhan tidak menyetujui transaksi.
            </p>
            {integrityResult==="MATCH" && <p role="status" className="text-sm text-sky-200">
              Integritas file privat PASS: byte, ukuran, dan SHA-256 cocok. Dokumen tetap
              PENDING_VERIFICATION; persetujuan dan posting belum diaktifkan.
            </p>}
            {integrityResult==="UNAVAILABLE" && <p role="alert" className="text-sm text-amber-200">
              Integritas belum dapat dikonfirmasi. Periksa sesi Owner, file privat,
              dan catatan server. Tidak ada perubahan pada status dokumen atau jurnal.
            </p>}
            {reviewedUpload?.transactionId===pendingEvidence.transactionId && verifiedId!==pendingEvidence.transactionId && (
              <div className="space-y-2">
                <p className="text-sm">Bukti asli: {reviewedUpload.file.name}. Periksa dokumen asli, nominal dan tanggal sebelum konfirmasi.</p>
                <Button type="button" disabled={evidenceBusy||integrityBusy||integrityResult!=="MATCH"} onClick={()=>void verifyEvidence()}>Verifikasi Bukti (tanpa posting)</Button>
              </div>
            )}
            <Button type="button" variant="outline" disabled={evidenceBusy||integrityBusy} onClick={()=>{
              try{window.sessionStorage.removeItem(COMPANY1_PENDING_ACK_KEY);}
              catch{/* Storage may be disabled. */}
              setPendingEvidence(null);setReviewedUpload(null);setVerifiedId(null);
              setIntegrityResult(null);
              draftRequestVersion.current++;
              setPreview(null);setReceiptFile(null);
              setAmount("");setCounterCoaId("");
            }}>Buat transaksi baru</Button>
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
