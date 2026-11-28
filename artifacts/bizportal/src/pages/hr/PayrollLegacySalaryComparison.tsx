import React,{useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";

type Status="LEGACY_AMOUNT_INVALID"|"SALARY_COMPONENTS_NOT_CONFIGURED"|
  "NUMBERS_MATCH_COMPONENTS_UNVERIFIED"|"AMOUNTS_DIFFER_COMPONENTS_UNVERIFIED";
type ComparisonRow={
  employeeId:number;employeeName:string;legacySalary:string|null;
  configuredBaseSalary:string|null;configuredAllowance:string|null;
  configuredTotal:string|null;differenceFromLegacy:string|null;
  effectiveFrom:string|null;status:Status;componentsVerified:false;
};
type Preview={
  companyId:number;runId:number;month:number;year:number;effectiveThrough:string;
  source:"public.employees.salary";legacyAmountSemantics:"UNKNOWN";
  activeEmployees:number;withPositiveLegacyAmount:number;
  withoutEffectiveSalaryProfile:number;numericMatches:number;numericDifferences:number;
  legacyReferenceTotal:string|null;configuredComparisonTotal:string|null;
  rows:ComparisonRow[];readOnly:true;componentsVerified:false;
  canImport:false;canMaterialize:false;canApprove:false;canPost:false;canPay:false;note:string;
};
const rupiah=(value:string|null)=>value===null?"Belum tersedia":new Intl.NumberFormat("id-ID",{
  style:"currency",currency:"IDR",maximumFractionDigits:2,
}).format(Number(value));
const labels:Record<Status,string>={
  LEGACY_AMOUNT_INVALID:"Nominal lama tidak valid",
  SALARY_COMPONENTS_NOT_CONFIGURED:"Struktur gaji belum diisi",
  NUMBERS_MATCH_COMPONENTS_UNVERIFIED:"Nominal sama; komponen belum diverifikasi",
  AMOUNTS_DIFFER_COMPONENTS_UNVERIFIED:"Nominal berbeda; perlu pemeriksaan",
};

export function PayrollLegacySalaryComparison(props:{companyId:number;runId:number}){
  return <LegacyComparison key={`${props.companyId}:${props.runId}`} {...props}/>;
}
function LegacyComparison({companyId,runId}:{companyId:number;runId:number}){
  const [preview,setPreview]=useState<Preview|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState("");
  const controller=useRef<AbortController|null>(null);
  const mounted=useRef(true);
  useEffect(()=>{
    mounted.current=true;
    return ()=>{mounted.current=false;controller.current?.abort();};
  },[]);
  async function load(){
    if(loading)return;
    controller.current?.abort();
    const signal=new AbortController();controller.current=signal;
    setLoading(true);setError("");setPreview(null);
    try{
      const res=await fetch(`/api/payroll/runs/${runId}/legacy-salary-comparison?companyId=${companyId}`,{
        credentials:"include",cache:"no-store",signal:signal.signal,
      });
      const body=await res.json();
      if(!res.ok)throw Error(body.message||`Gagal membaca perbandingan (HTTP ${res.status}).`);
      if(body.companyId!==companyId||body.runId!==runId||body.source!=="public.employees.salary"||
        body.legacyAmountSemantics!=="UNKNOWN"||body.readOnly!==true||
        body.componentsVerified!==false||body.canImport!==false||
        body.canMaterialize!==false||body.canApprove!==false||
        body.canPost!==false||body.canPay!==false||
        !Array.isArray(body.rows)||body.rows.length!==body.activeEmployees)
        throw Error("Validasi pratinjau gaji/perusahaan gagal.");
      if(mounted.current&&!signal.signal.aborted)setPreview(body as Preview);
    }catch(e){
      if(mounted.current&&!signal.signal.aborted)
        setError(e instanceof Error?e.message:"Pratinjau belum tersedia.");
    }finally{if(mounted.current&&!signal.signal.aborted)setLoading(false);}
  }
  return <section aria-label="Perbandingan nominal gaji historis" className="rounded-md border p-3 space-y-3">
    <div className="space-y-1">
      <h4 className="text-sm font-semibold">Perbandingan Master Gaji Lama → Struktur Payroll — DEV</h4>
      <p className="text-xs text-muted-foreground">Baca-saja. Nilai di master karyawan belum diketahui termasuk uang makan, tunjangan, atau potongan. Tidak ada pemindahan otomatis.</p>
    </div>
    <Button type="button" variant="outline" disabled={loading} onClick={load}>
      {loading?"Membaca sumber gaji...":"Bandingkan Nominal Master Gaji (Baca-saja)"}
    </Button>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {preview&&<>
      <p role="status" className="text-xs font-medium">Periode {String(preview.month).padStart(2,"0")}/{preview.year} — karyawan aktif: {preview.activeEmployees}; nominal master tersedia: {preview.withPositiveLegacyAmount}; struktur gaji belum lengkap: {preview.withoutEffectiveSalaryProfile}.</p>
      <div className="grid gap-2 sm:grid-cols-2 text-xs">
        <p>Jumlah nominal lama (hanya referensi): <strong>{rupiah(preview.legacyReferenceTotal)}</strong></p>
        <p>Jumlah konfigurasi Payroll yang tersedia (bukan gaji final): <strong>{rupiah(preview.configuredComparisonTotal)}</strong></p>
      </div>
      <p className="text-amber-600 text-xs">Belum aman menganggap nominal master sebagai gaji pokok atau gaji bersih. Kesamaan nominal tidak membuktikan komponennya benar. Konfirmasi uang makan, tunjangan, BPJS/PPh21, serta potongan kasbon secara terpisah.</p>
      <div className="max-h-96 overflow-auto">
        <table className="min-w-[960px] w-full text-xs">
          <thead><tr className="border-b text-left">
            <th className="p-2">Karyawan</th><th className="p-2">Nominal lama</th>
            <th className="p-2">Gaji pokok Payroll</th><th className="p-2">Tunjangan Payroll</th>
            <th className="p-2">Total konfigurasi</th><th className="p-2">Selisih nominal</th>
            <th className="p-2">Status verifikasi</th>
          </tr></thead>
          <tbody>{preview.rows.map(row=><tr key={row.employeeId} className="border-b">
            <td className="p-2">{row.employeeName} <span className="text-muted-foreground">#{row.employeeId}</span></td>
            <td className="p-2 tabular-nums">{rupiah(row.legacySalary)}</td>
            <td className="p-2 tabular-nums">{rupiah(row.configuredBaseSalary)}</td>
            <td className="p-2 tabular-nums">{rupiah(row.configuredAllowance)}</td>
            <td className="p-2 tabular-nums">{rupiah(row.configuredTotal)}</td>
            <td className="p-2 tabular-nums">{rupiah(row.differenceFromLegacy)}</td>
            <td className="p-2">{labels[row.status]}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{preview.note} Posting jurnal, persetujuan pembayaran, impor massal, dan perubahan master tetap terkunci.</p>
    </>}
  </section>;
}
