import {useCallback,useEffect,useState} from "react";
import {Link} from "wouter";
import {AppShell} from "@/components/layout/AppShell";
import {Card,CardContent,CardHeader,CardTitle} from "@/components/ui/card";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
import {useCompany} from "@/contexts/CompanyContext";
import {FinanceCompanyScopeCard} from "@/pages/purchase/FinanceCompanyScopeCard";
import {requestFinanceCompanyScope} from "@/lib/financeCompanyScope";

type Scenario={
 id:number;companyId:number;reference:string;amount:string;
 status:"pending"|"approved";approvedAt:string|null;
};
type Data={scenario:Scenario;sandbox:true;bankTransfer:false;glPosted:false};
export default function FinancePaymentApprovalQa(){
 const {activeCompanyId}=useCompany();
 const [data,setData]=useState<Data|null>(null);
 const [loading,setLoading]=useState(true);
 const [submitting,setSubmitting]=useState(false);
 const [error,setError]=useState("");
 const [receipt,setReceipt]=useState("");
 const load=useCallback(async()=>{
  setLoading(true);setError("");setData(null);
  try{
   let response=await fetch("/api/mkt/admin/payment-approval-qa",{credentials:"include",cache:"no-store"});
   // This sandbox screen may be opened directly from a company selected in
   // BizPortal before the separate signed Finance-scope cookie is issued.
   // On 403 ONLY, ask the existing server to verify that explicit selection.
   // It refuses non-Super Admin, cross-company and unauthorized companies.
   if(response.status===403 && (activeCompanyId===1||activeCompanyId===3)){
    await requestFinanceCompanyScope(activeCompanyId);
    response=await fetch("/api/mkt/admin/payment-approval-qa",{credentials:"include",cache:"no-store"});
   }
   const body=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(body.error??"Skenario QA belum tersedia");
   if(body.sandbox!==true||body.bankTransfer!==false||body.glPosted!==false||
       body.scenario?.companyId!==activeCompanyId)
    throw Error("Kontrak keamanan QA atau perusahaan tidak sesuai");
   setData(body as Data);
  }catch(e){setError(e instanceof Error?e.message:"Gagal memuat persetujuan QA");}
  finally{setLoading(false);}
 },[activeCompanyId]);
 useEffect(()=>{void load();},[load]);
 async function approve(){
  if(!data||data.scenario.status!=="pending"||submitting)return;
  setSubmitting(true);setError("");setReceipt("");
  try{
   const response=await fetch("/api/mkt/admin/payment-approval-qa",{
    method:"POST",credentials:"include",cache:"no-store",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({scenarioId:data.scenario.id}),
   });
   const body=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(body.error??"Persetujuan gagal");
   if(body.sandbox!==true||body.bankTransfer!==false||body.glPosted!==false)
     throw Error("Kontrak penerimaan tidak sesuai");
   setReceipt(`PASS — ${body.reference}: persetujuan dicatat oleh sesi Super Admin dalam database QA terisolasi.`);
   await load();
  }catch(e){setError(e instanceof Error?e.message:"Persetujuan gagal");}
  finally{setSubmitting(false);}
 }
 return <AppShell>
  <div className="mx-auto max-w-4xl space-y-5 p-6">
   <div className="flex flex-wrap items-center justify-between gap-3">
    <div><h1 className="text-2xl font-semibold">Persetujuan Pembayaran — Pengujian DEV</h1>
    <p className="text-sm text-muted-foreground">Sesi Super Admin asli · skenario sintetis · tanpa transfer bank atau posting GL</p></div>
    <div className="flex flex-col gap-2 text-sm">
     <Link href="/finance/po14-e2e-qa" className="underline font-semibold">Uji E2E internal PO #14 (simulasi)</Link>
     <Link href="/purchase/vendor-invoices" className="underline">Kembali ke Vendor Invoice</Link>
    </div>
   </div>
   {data
    ? <p role="status" className="text-sm text-green-600">
       Perusahaan Finance sudah diverifikasi oleh server untuk sesi ini.
      </p>
    : <FinanceCompanyScopeCard onVerified={()=>void load()}/>}
   <Card><CardHeader><CardTitle className="text-base">Transaksi uji persetujuan</CardTitle></CardHeader>
    <CardContent className="space-y-4">
     <div className="flex flex-wrap gap-2">
      <Badge variant="secondary">SANDBOX</Badge>
      <Badge variant="outline">Tidak mengirim uang</Badge>
      <Badge variant="outline">Tidak membuat jurnal bisnis</Badge>
     </div>
     {loading?<p role="status">Memeriksa sesi dan transaksi QA...</p>:data?<>
      <div className="grid gap-2 text-sm">
       <p><strong>Referensi:</strong> {data.scenario.reference}</p>
       <p><strong>Perusahaan:</strong> {data.scenario.companyId===1?"PT Cahaya Sejati Teknologi":"PT Diva Servis"}</p>
       <p><strong>Nominal simulasi:</strong> Rp {Number(data.scenario.amount).toLocaleString("id-ID")}</p>
       <p><strong>Status:</strong> {data.scenario.status==="pending"?"Menunggu persetujuan":"Sudah disetujui (QA)"}</p>
      </div>
      <Button disabled={submitting||data.scenario.status!=="pending"} onClick={()=>void approve()}>
       {submitting?"Memproses persetujuan...":data.scenario.status==="approved"?"Persetujuan QA tercatat":"Setujui Pembayaran Uji"}
      </Button>
     </>:<p className="text-sm">Skenario uji belum dapat dibaca. Periksa izin sesi Finance DEV.</p>}
     {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
     {receipt&&<p role="status" className="text-sm text-green-600">{receipt}</p>}
     <Button variant="outline" type="button" disabled={loading||submitting} onClick={()=>void load()}>Periksa ulang status</Button>
    </CardContent></Card>
   <p className="text-sm text-muted-foreground">
    Halaman ini hanya membuktikan tombol dan otorisasi Super Admin pada database QA.
    Ini <strong>bukan</strong> persetujuan pembayaran supplier asli dan belum membuktikan bank reconciliation atau GL E2E operasional.
   </p>
  </div>
 </AppShell>;
}
