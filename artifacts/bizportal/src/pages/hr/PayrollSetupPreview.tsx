import React,{useEffect,useState} from "react";
import {Button} from "@/components/ui/button";

type PreviewRow={employeeId:number;employeeName:string;gross:string|null;net:string|null;
  deductions:{kasbon_deduction:string|null};issues:string[]};
type Preview={companyId:number;runId:number;year:number;month:number;employeeCount:number;
  configuredCount:number;missingSalaryCount:number;missingDeductionConfigCount:number;invalidCount:number;
  rows:PreviewRow[];readOnly:true;persisted:false;canMaterialize:false;readyForPayment:false};
type Props={companyId:number;runId:number;year:number;month:number};
const fmt=(v:string|null)=>v===null?"Belum tersedia":new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:2}).format(Number(v));
const moneyValue=(v:unknown):v is string|null=>v===null||(typeof v==="string"&&/^[0-9]+(?:\.[0-9]{1,2})?$/.test(v)&&Number.isFinite(Number(v)));
const issues:Record<string,string>={
  STRUKTUR_GAJI_BELUM_ADA:"Struktur gaji belum ada",
  POTONGAN_BELUM_DIKONFIRMASI:"Potongan belum dikonfirmasi",
  KASBON_PLAN_SOURCE_NOT_ELIGIBLE:"Kasbon belum memenuhi syarat pencairan/jurnal",
  PILIH_PENUH_ATAU_CICILAN:"Pilih potong penuh atau cicilan",
  KASBON_BELUM_DIRENCANAKAN_OTOMATIS:"Rencana potongan kasbon belum terverifikasi",
  POTONGAN_MELEBIHI_GAJI:"Potongan melebihi gaji",
  POTONGAN_PERIODE_LAIN_BELUM_DIKONFIRMASI:"Potongan periode lain belum dikonfirmasi",
  KASBON_SUDAH_DIPERSIAPKAN_RUN_LAIN:"Kasbon telah dicadangkan pada Draft lain",
  TOTAL_SALARY_NOL:"Gaji pokok nol",
};
function validPreview(v:unknown,p:Props):v is Preview{
  if(!v||typeof v!=="object")return false;
  const x=v as Preview;
  return x.companyId===p.companyId&&x.runId===p.runId&&x.year===p.year&&x.month===p.month&&
    x.readOnly===true&&x.persisted===false&&x.canMaterialize===false&&x.readyForPayment===false&&
    [x.employeeCount,x.configuredCount,x.missingSalaryCount,x.missingDeductionConfigCount,x.invalidCount]
      .every(n=>Number.isSafeInteger(n)&&n>=0)&&
    Array.isArray(x.rows)&&x.employeeCount===x.rows.length&&x.rows.every(r=>
      Number.isSafeInteger(r.employeeId)&&r.employeeId>0&&typeof r.employeeName==="string"&&
      moneyValue(r.gross)&&moneyValue(r.net)&&r.deductions&&moneyValue(r.deductions.kasbon_deduction)&&
      Array.isArray(r.issues)&&r.issues.every(s=>typeof s==="string"));
}

/** Projection only. Remounted when the selected company or run changes. */
export function PayrollSetupPreview(props:Props){
  const {companyId,runId,year,month}=props;
  const [attempt,setAttempt]=useState(0);
  const [result,setResult]=useState<Preview|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    if(attempt===0)return;
    const controller=new AbortController();
    let active=true;
    setLoading(true);setResult(null);setError("");
    fetch("/api/payroll/runs/"+runId+"/setup-preview?companyId="+companyId,{
      credentials:"include",cache:"no-store",signal:controller.signal,
    }).then(async response=>{
      const data:unknown=await response.json().catch(()=>null);
      if(!response.ok)throw Error("Pratinjau gaji belum dapat dimuat.");
      if(!validPreview(data,{companyId,runId,year,month}))throw Error("Lingkup atau status pratinjau tidak sesuai.");
      if(active)setResult(data);
    }).catch(e=>{if(active)setError(e instanceof Error?e.message:"Pratinjau tidak tersedia.");})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;controller.abort();};
  },[attempt,companyId,runId,year,month]);
  return <section aria-label="Pratinjau gaji dan kasbon" className="space-y-3 rounded-md border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-semibold">Pratinjau Gaji &amp; Kasbon</h3>
        <p className="text-xs text-muted-foreground">DEV · Baca-saja. Tidak menyimpan potongan, tidak mengubah saldo kasbon dan tidak membayar gaji.</p></div>
      <Button variant="outline" disabled={loading} onClick={()=>setAttempt(n=>n+1)}>{loading?"Memuat pratinjau…":result?"Muat ulang pratinjau":"Tampilkan pratinjau"}</Button>
    </div>
    {error&&<p role="alert" className="text-sm text-red-500">{error}</p>}
    {result&&result.companyId===companyId&&result.runId===runId&&result.year===year&&result.month===month&&<>
      <p role="status" className="text-sm">{result.configuredCount}/{result.employeeCount} karyawan memiliki struktur gaji efektif. {result.missingSalaryCount} belum memiliki struktur gaji; {result.missingDeductionConfigCount} belum lengkap potongannya.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr className="border-b"><th className="p-2">Karyawan</th><th className="p-2 text-right">Gaji kotor</th><th className="p-2 text-right">Usulan kasbon</th><th className="p-2 text-right">Usulan bersih</th><th className="p-2">Kesiapan</th></tr></thead>
        <tbody>{result.rows.map(row=><tr key={row.employeeId} className="border-b">
          <td className="p-2">{row.employeeName}</td><td className="p-2 text-right">{fmt(row.gross)}</td>
          <td className="p-2 text-right">{fmt(row.deductions.kasbon_deduction)}</td>
          <td className="p-2 text-right">{fmt(row.issues.length?null:row.net)}</td>
          <td className="p-2">{row.issues.length?row.issues.map(s=>issues[s]??s.replaceAll("_"," ")).join("; "):row.net===null?"Belum lengkap":"Siap dipratinjau"}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="text-xs text-muted-foreground">Nominal belum tersedia bukan Rp0. Kasbon yang belum dicairkan atau belum memiliki jurnal tidak menjadi potongan otomatis.</p>
    </>}
  </section>;
}
