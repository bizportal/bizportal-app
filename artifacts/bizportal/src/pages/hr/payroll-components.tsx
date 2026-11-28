import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

const fields = [
  {key:"baseSalary", label:"Gaji Pokok"},
  {key:"allowance", label:"Tunjangan (termasuk uang makan)"},
  {key:"kasbonDeduction", label:"Potongan Kasbon / Cicilan Gaji"},
  {key:"bpjsJhtEmployee", label:"BPJS JHT"},
  {key:"bpjsKesEmployee", label:"BPJS Kesehatan"},
  {key:"pph21", label:"PPh21"},
  {key:"otherDeductions", label:"Potongan Lainnya"},
] as const;
type Key = typeof fields[number]["key"];
type Values = Record<Key,string>;
type Employee = {id:number;firstName:string;lastName:string};
type EmployeeResponse = {companyId:number;employees:Employee[];canEdit:boolean};
type ConfigResponse = {companyId:number;employeeId:number;effectiveFrom:string|null;notes:string;
  values:Record<Key,string|null>;complete:boolean;
  summary:null|{gross:string;deductions:string;net:string};masterSalaryCandidate:string|null;
};
const blank = ():Values => Object.fromEntries(fields.map(x=>[x.key,""])) as Values;
const moneyRegex=/^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/;
function cents(raw:string):bigint|null {
  if(!moneyRegex.test(raw))return null;
  const [a,b=""]=raw.split(".");
  return BigInt(a)*100n+BigInt(b.padEnd(2,"0"));
}
function asMoney(v:bigint):string {
  const n=v<0n?-v:v;
  return (v<0n?"-":"")+(n/100n).toString()+"."+(n%100n).toString().padStart(2,"0");
}
function formatted(v:string):string {
  return new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",
    minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(v));
}
const initialDate=()=>{
  const d=new Date();
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),"01"].join("-");
};
async function api<T>(path:string, options:RequestInit={}):Promise<T> {
  const r=await fetch(path,{credentials:"include",cache:"no-store",headers:{"Content-Type":"application/json"},...options});
  let data:any={};try{data=await r.json()}catch{}
  if(!r.ok)throw Error(data.message??"Permintaan Payroll gagal ("+r.status+").");
  return data as T;
}
// Restored from the original seven-component Payroll editor; DEV only.
export default function PayrollStandaloneComponents({companyId:validCompany}:{companyId:number}){
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [selected,setSelected]=useState("");
  const [values,setValues]=useState<Values>(blank);
  const [effectiveFrom,setEffectiveFrom]=useState(initialDate);
  const [notes,setNotes]=useState("");
  const [canEdit,setCanEdit]=useState(false);
  const [masterSalaryCandidate,setMasterSalaryCandidate]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [lastReadback,setLastReadback]=useState<null|{gross:string;deductions:string;net:string}>(null);
  useEffect(()=>{
    let alive=true;
    setEmployees([]);setSelected("");setValues(blank());setCanEdit(false);
    setMasterSalaryCandidate(null);
    setNotes("");setError("");setNotice("");setLastReadback(null);
    if(validCompany===null)return()=>{alive=false};
    setLoading(true);
    api<EmployeeResponse>("/api/payroll/components/employees?companyId="+validCompany)
      .then(d=>{if(!alive)return;if(d.companyId!==validCompany)throw Error("Perusahaan pada respons tidak cocok");
        setEmployees(d.employees);setCanEdit(d.canEdit===true);})
      .catch(e=>{if(alive)setError(e instanceof Error?e.message:"Data karyawan tidak dapat dibaca.")})
      .finally(()=>{if(alive)setLoading(false)});
    return()=>{alive=false};
  },[validCompany]);
  useEffect(()=>{
    let alive=true;
    setValues(blank());setNotes("");setLastReadback(null);setError("");setMasterSalaryCandidate(null);
    if(!selected||validCompany===null)return()=>{alive=false};
    setLoading(true);
    api<ConfigResponse>("/api/payroll/components/"+selected+"?companyId="+validCompany)
      .then(d=>{
        if(!alive)return;
        if(d.companyId!==validCompany||d.employeeId!==Number(selected))throw Error("Data karyawan tidak sesuai.");
        setEffectiveFrom(d.effectiveFrom??initialDate());
        setNotes(d.notes??"");
        setMasterSalaryCandidate(d.masterSalaryCandidate??null);
        setValues(Object.fromEntries(fields.map(f=>[f.key,d.values[f.key]??""])) as Values);
      })
      .catch(e=>{if(alive)setError(e instanceof Error?e.message:"Komponen gaji tidak dapat dibaca.")})
      .finally(()=>{if(alive)setLoading(false)});
    return()=>{alive=false};
  },[selected,validCompany]);
  const calc=useMemo(()=>{
    const list=fields.map(f=>cents(values[f.key]));
    if(list.some(x=>x===null))return null;
    const gross=list[0]!+list[1]!;
    const deductions=list.slice(2).reduce<bigint>((sum,v)=>sum+v!,0n);
    return {gross,deductions,net:gross-deductions};
  },[values]);
  const kasbon=cents(values.kasbonDeduction);
  const ready=!!selected&&canEdit&&!busy&&!loading&&calc!==null&&kasbon===0n&&
    calc.gross>0n&&cents(values.baseSalary)!>0n&&calc.net>=0n&&notes.trim().length>=5&&notes.length<=500;
  async function save(){
    if(!ready||validCompany===null||!selected||!calc)return;
    if(!window.confirm("Konfirmasi tujuh komponen gaji mulai "+effectiveFrom+
      "? Pastikan nominal sudah diverifikasi. Tidak ada pembayaran, jurnal, atau pelunasan kasbon."))return;
    const scope=validCompany, employeeId=Number(selected);
    setBusy(true);setError("");setNotice("");setLastReadback(null);
    try{
      const saved=await api<{companyId:number;employeeId:number;componentsSaved:number;gross:string;deductions:string;net:string;paid:false;posted:false}>(
        "/api/payroll/components/"+employeeId+"?companyId="+scope,
        {method:"PUT",body:JSON.stringify({...values,effectiveFrom,notes,confirm:true})});
      if(saved.companyId!==scope||saved.employeeId!==employeeId||saved.componentsSaved!==7||
        saved.gross!==asMoney(calc.gross)||saved.deductions!==asMoney(calc.deductions)||
        saved.net!==asMoney(calc.net))throw Error("Respons perhitungan tidak cocok.");
      const verify=await api<ConfigResponse>(
        "/api/payroll/components/"+employeeId+"?companyId="+scope);
      if(!verify.complete||verify.summary?.net!==saved.net||verify.summary?.deductions!==saved.deductions)
        throw Error("Simpan berhasil tetapi baca ulang belum cocok; periksa sebelum melanjutkan.");
      setLastReadback({gross:saved.gross,deductions:saved.deductions,net:saved.net});
      setNotice("Tujuh komponen tersimpan dan diverifikasi. Muat ulang Pratinjau Gaji & Kasbon. Tidak ada transaksi keuangan dibuat.");
    }catch(e){setError(e instanceof Error?e.message:"Gagal menyimpan komponen Payroll.");}
    finally{setBusy(false);}
  }
  return <section className="space-y-4 rounded-lg border p-4">
    <div><h2 className="text-lg font-semibold">Gaji, Tunjangan dan Potongan</h2>
      <p className="text-sm text-muted-foreground">Konfigurasi efektif Payroll DEV. Data master HRD hanya referensi; potongan tidak diisi otomatis.</p></div>
    {error&&<div role="alert" className="rounded-md border border-red-500 p-3 text-sm text-red-500">{error}</div>}
    {notice&&<div role="status" className="rounded-md border p-3 text-sm">{notice}</div>}
    <div className="space-y-4">
      <label className="block text-sm">Karyawan aktif
        <select aria-label="Karyawan Payroll" className="mt-1 w-full rounded border bg-background p-2" value={selected}
          disabled={busy||loading} onChange={e=>setSelected(e.target.value)}>
          <option value="">Pilih karyawan...</option>
          {employees.map(e=><option key={e.id} value={e.id}>{e.firstName} {e.lastName} (#{e.id})</option>)}
        </select>
      </label>
      {selected && <div role="status" className="rounded border p-3 text-sm">
        Referensi nominal gaji dari master HRD: <strong>{masterSalaryCandidate===null?"Belum tersedia":formatted(masterSalaryCandidate)}</strong>.
        Nilai ini belum menjadi gaji pokok efektif sampai dikonfirmasi.
        {masterSalaryCandidate!==null && <Button type="button" variant="outline" size="sm" className="ml-2"
          disabled={loading||busy} onClick={()=>{setValues(v=>({...v,baseSalary:masterSalaryCandidate}));setLastReadback(null);}}>
          Gunakan sebagai calon gaji pokok
        </Button>}
      </div>}
      <label className="block text-sm">Tanggal mulai berlaku konfigurasi
        <input aria-label="Tanggal gaji berlaku" className="mt-1 w-full rounded border bg-background p-2" type="date"
          value={effectiveFrom} onChange={e=>{setEffectiveFrom(e.target.value);setLastReadback(null)}}/>
        <span className="mt-1 block text-xs text-muted-foreground">Tanggal ini menyimpan versi konfigurasi, bukan tanggal pencairan atau jadwal pelunasan kasbon.</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(f=><label key={f.key} className="text-sm">{f.label} (Rp)
          <input aria-label={f.label} className="mt-1 w-full rounded border bg-background p-2" inputMode="decimal"
            placeholder="Kosong jika belum diverifikasi; ketik 0 jika nihil"
            value={values[f.key]} onChange={e=>{setValues(v=>({...v,[f.key]:e.target.value.trim()}));setLastReadback(null)}}/>
          {f.key==="kasbonDeduction"&&<span className="mt-1 block text-xs text-muted-foreground">
            Ketik 0 untuk potongan manual. Kasbon otomatis hanya berasal dari pencairan yang sudah terverifikasi.
          </span>}
        </label>)}
      </div>
      <label className="block text-sm">Catatan sumber persetujuan gaji dan potongan (wajib)
        <textarea aria-label="Sumber komponen gaji" className="mt-1 w-full rounded border bg-background p-2"
          maxLength={500} value={notes} onChange={e=>{setNotes(e.target.value);setLastReadback(null)}}
          placeholder="Contoh: Konfirmasi HRD/Owner atas komponen gaji efektif November."/>
      </label>
      <div className="grid gap-2 sm:grid-cols-3 text-sm">
        <div className="rounded border p-3">Gaji kotor <strong className="block">{calc?formatted(asMoney(calc.gross)):"Belum lengkap"}</strong></div>
        <div className="rounded border p-3">Total potongan <strong className="block">{calc?formatted(asMoney(calc.deductions)):"Belum lengkap"}</strong></div>
        <div className="rounded border p-3">Gaji bersih <strong className="block">
          {calc?(calc.net<0n?"Potongan melebihi gaji":formatted(asMoney(calc.net))):"Belum lengkap"}</strong></div>
      </div>
      {kasbon!==null && kasbon>0n &&
        <p role="alert" className="text-sm text-red-600">Potongan kasbon manual harus Rp0 sebelum menggunakan rencana Penuh/Cicilan otomatis. Data lama tidak ditimpa otomatis.</p>}
      <Button onClick={()=>void save()} disabled={!ready}> {busy?"Menyimpan...":"Simpan Gaji & Seluruh Potongan"} </Button>
      {!canEdit&&<p className="text-xs text-muted-foreground">Penyimpanan belum diaktifkan atau akun tidak berwenang. Tidak ada data diubah.</p>}
      {lastReadback&&<p role="status" className="text-sm">Baca ulang terverifikasi: gaji bersih {formatted(lastReadback.net)}.</p>}
    </div>
  </section>;
}
