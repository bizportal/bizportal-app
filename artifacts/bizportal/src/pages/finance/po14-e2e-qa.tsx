import {useCallback,useEffect,useState} from "react";
import {Link} from "wouter";
import {AppShell} from "@/components/layout/AppShell";
import {Card,CardContent,CardHeader,CardTitle} from "@/components/ui/card";
import {Button} from "@/components/ui/button";
import {Badge} from "@/components/ui/badge";
import {useCompany} from "@/contexts/CompanyContext";
import {FinanceCompanyScopeCard} from "@/pages/purchase/FinanceCompanyScopeCard";
import {requestFinanceCompanyScope} from "@/lib/financeCompanyScope";
type Step={stage:string;status:"SIMULATED";reference:string};
type Receipt={id:number;reference:string;companyId:1;actor:string;status:string;amount:string;
  steps:Step[];createdAt:string;auditCount:number};
type Data={sandbox:true;bankTransfer:false;businessLedgerPosted:false;
  actualBankReconcilerExecuted:false;actualVendorInvoiceCreated:false;result:Receipt|null};
const endpoint="/api/mkt/admin/po14-e2e-qa";
function safeResponse(data:any):data is Data {
 return data?.sandbox===true&&data.bankTransfer===false&&
   data.businessLedgerPosted===false&&data.actualBankReconcilerExecuted===false&&
   data.actualVendorInvoiceCreated===false&&
   (data.result===null || (data.result?.reference==="PO-20261117-00014"&&
    data.result.companyId===1&&Array.isArray(data.result.steps)&&
    data.result.steps.every((s:any)=>s.status==="SIMULATED")));
}
export default function Po14E2eQa(){
 const {activeCompanyId}=useCompany();
 const [data,setData]=useState<Data|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const [running,setRunning]=useState(false);
 const load=useCallback(async()=>{
  setLoading(true);setError("");setData(null);
  try{
   let result=await fetch(endpoint,{credentials:"include",cache:"no-store"});
   if(result.status===403 && activeCompanyId===1){
     await requestFinanceCompanyScope(1);
     result=await fetch(endpoint,{credentials:"include",cache:"no-store"});
   }
   const payload=await result.json().catch(()=>({}));
   if(!result.ok)throw Error(payload.error??"Bukti QA belum tersedia");
   if(!safeResponse(payload))throw Error("Kontrak QA tidak sesuai");
   setData(payload);
  }catch(e){setError(e instanceof Error?e.message:"Gagal memuat QA");}
  finally{setLoading(false);}
 },[activeCompanyId]);
 useEffect(()=>{void load();},[load]);
 async function run(){
  if(activeCompanyId!==1||running)return;
  setRunning(true);setError("");
  try{
   const r=await fetch(endpoint,{method:"POST",credentials:"include",cache:"no-store",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({reference:"PO-20261117-00014"})});
   const body=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(body.error??"Uji PO14 gagal");
   if(!safeResponse(body)||!body.result)throw Error("Kontrak hasil QA tidak sesuai");
   setData(body);
  }catch(e){setError(e instanceof Error?e.message:"Uji QA gagal");}
  finally{setRunning(false);}
 }
 return <AppShell>
  <div className="mx-auto max-w-4xl space-y-5 p-6">
   <div className="flex items-center justify-between gap-3 flex-wrap">
    <div>
     <h1 className="text-2xl font-semibold">Uji Alur PO #14 — Finance DEV</h1>
     <p className="text-sm text-muted-foreground">Sesi Super Admin sah · PostgreSQL QA terisolasi · bukan pembayaran nyata</p>
    </div>
    <Link href="/finance/payment-approval-qa" className="text-sm underline">Persetujuan QA sebelumnya</Link>
   </div>
   <Card><CardHeader><CardTitle className="text-base">Referensi yang disetujui untuk pengujian internal</CardTitle></CardHeader>
    <CardContent className="space-y-2 text-sm">
     <p><strong>PO:</strong> PO-20261117-00014 · <strong>GR:</strong> #6 · <strong>Shipment:</strong> #8</p>
     <p><strong>Supplier:</strong> CST (internal) · <strong>Item:</strong> Frozen Tuna Saku · <strong>Nominal:</strong> Rp100.000</p>
     <p className="font-medium">Semua Invoice, AP, Payment Request, bank dan jurnal di bawah adalah simulasi QA. Tidak membuat utang atau jurnal CST-DEV.</p>
    </CardContent>
   </Card>
   {activeCompanyId!==1 ? <FinanceCompanyScopeCard onVerified={()=>void load()}/>:
    !data&&error ? <FinanceCompanyScopeCard onVerified={()=>void load()}/> :
    data&&<p role="status" className="text-sm text-green-600">Perusahaan Finance CST telah diverifikasi oleh server untuk sesi ini.</p>}
   <Card><CardHeader><CardTitle className="text-base">Hasil pengujian alur</CardTitle></CardHeader>
    <CardContent className="space-y-4">
     <div className="flex gap-2 flex-wrap">
      <Badge variant="secondary">SANDBOX</Badge>
      <Badge variant="outline">Tidak ada transfer bank</Badge>
      <Badge variant="outline">Tidak membuat GL bisnis</Badge>
     </div>
     {loading?<p role="status">Memverifikasi sesi dan membaca bukti uji...</p>:
      data?.result?<div className="space-y-3">
       <p role="status" className="font-semibold">Bukti simulasi tercatat · audit: {data.result.auditCount}</p>
       <p className="text-sm">Aktor sesi: {data.result.actor} · nominal Rp{Number(data.result.amount).toLocaleString("id-ID")}</p>
       <div className="space-y-2">
        {data.result.steps.map((s,i)=><div key={i} className="rounded-md border p-3 text-sm">
         <div className="flex items-center justify-between gap-2">
          <strong>{i+1}. {s.stage}</strong><Badge variant="outline">{s.status}</Badge>
         </div><p className="text-muted-foreground mt-1">{s.reference}</p>
        </div>)}
       </div>
      </div>:<p className="text-sm">Belum ada bukti simulasi untuk PO #14.</p>}
     {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
     {!error && !loading && activeCompanyId===1 &&
      <Button onClick={()=>void run()} disabled={running||!data}>
       {running?"Mencatat simulasi...":data?.result?"Ulangi pemeriksaan (replay aman)":"Jalankan Simulasi E2E PO #14"}
      </Button>}
     <Button variant="outline" onClick={()=>void load()} disabled={loading||running}>Periksa ulang status</Button>
    </CardContent>
   </Card>
   <p className="text-sm text-muted-foreground">
    Laporan ini hanya membuktikan permintaan aplikasi bertanda tangan Super Admin dan catatan tahapan sintetis di database QA.
    Ini bukan bukti Invoice asli diterbitkan, rekonsiliasi bank aktual dijalankan, atau posting GL bisnis dilakukan.
   </p>
  </div>
 </AppShell>;
}
