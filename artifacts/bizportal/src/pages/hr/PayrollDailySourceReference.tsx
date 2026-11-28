import React,{useState} from "react";
import {Button} from "@/components/ui/button";
import {previewDailySourcePaste} from "./payroll-daily-source-paste";
type Result=ReturnType<typeof previewDailySourcePaste>;
const money=(v:string|null)=>v===null?"Belum tersedia":new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:2}).format(Number(v));
export function PayrollDailySourceReference({year,month}:{year:number;month:number}){
  const [paste,setPaste]=useState("");
  const [mode,setMode]=useState<"raw"|"id"|"en">("id");
  const [preview,setPreview]=useState<Result|null>(null);
  const [error,setError]=useState("");
  function reset(){setPreview(null);setError("");}
  function check(){
    reset();
    try{setPreview(previewDailySourcePaste(paste,mode,year,month));}
    catch{setError("Sumber belum dapat diperiksa. Salin hanya kolom A–F dengan judul yang sesuai; pilih format angka yang cocok. Kosong bukan nol.");}
  }
  return <section aria-label="Referensi gaji harian" className="space-y-3 rounded-md border p-3">
    <h3 className="font-semibold">Periksa Tarif Harian dari Sumber Gaji — DEV</h3>
    <p className="text-xs text-muted-foreground">Salin A–F dari lembar gaji (NO, NAMA, UANG MAKAN, Hari Kerja, PERSENTASE, Total Salary). Header berulang dan baris TOTAL dikenali. Data hanya dihitung pada browser, tidak dikirim atau disimpan. Jangan salin nomor rekening.</p>
    <label className="block text-sm">Format angka
      <select aria-label="Format angka sumber" className="ml-2 rounded border bg-background p-2" value={mode} onChange={e=>{setMode(e.target.value as "raw"|"id"|"en");reset();}}>
        <option value="id">Indonesia (1.234,56)</option>
        <option value="en">Internasional (1,234.56)</option>
        <option value="raw">Mentah tanpa pemisah ribuan (1234.56)</option>
      </select>
    </label>
    <textarea aria-label="Sumber tarif harian" className="min-h-28 w-full rounded border bg-background p-2 font-mono text-xs" value={paste} maxLength={100000} onChange={e=>{setPaste(e.target.value);reset();}}/>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={!paste.trim()} onClick={check}>Periksa Sumber Gaji</Button>
      <Button type="button" variant="ghost" onClick={()=>{setPaste("");reset();}}>Bersihkan</Button>
    </div>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {preview&&<>
      <p role="status" className="text-sm">Periode {preview.period}: {preview.employeeRows} baris; {preview.dailyArithmeticMatches} rumus cocok; {preview.dailyArithmeticMismatches} berbeda; {preview.withoutVerifiedDailyBasis} tanpa dasar harian; {preview.missingMealAllowance} uang makan belum diketahui.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <thead><tr><th className="p-2">Baris / nama sumber</th><th className="p-2">Hari</th><th className="p-2">Tarif</th><th className="p-2">Total Salary sumber</th><th className="p-2">Hari × tarif</th><th className="p-2">Uang makan</th><th className="p-2">Hasil cek</th></tr></thead>
        <tbody>{preview.rows.map(row=><tr key={row.rowNumber} className="border-t">
          <td className="p-2">#{row.rowNumber} {row.employeeLabel}</td><td className="p-2">{row.workDaysReference??"—"}</td><td className="p-2">{row.dailyRateReference??"—"}</td>
          <td className="p-2">{money(row.totalSalaryReference)}</td><td className="p-2">{money(row.computedDailySalaryReference)}</td><td className="p-2">{money(row.mealAllowanceReference)}</td>
          <td className="p-2">{row.arithmeticMatch===null?"Belum diketahui":row.arithmeticMatch?"Rumus cocok":"Nominal berbeda"}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="text-xs text-muted-foreground">{preview.note} Identitas dan potongan tetap perlu dikonfirmasi; tidak ada gaji pokok atau gaji bersih yang dibuat.</p>
    </>}
  </section>;
}
