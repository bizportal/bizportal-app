// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {PayrollLegacySalaryComparison} from "@/pages/hr/PayrollLegacySalaryComparison";
const calls:Array<{url:string;method:string}>=[];
let wrongCompany=false;
beforeEach(()=>{
 calls.length=0;wrongCompany=false;
 vi.stubGlobal("fetch",vi.fn(async(url:string,options?:RequestInit)=>{
   calls.push({url:String(url),method:options?.method??"GET"});
   return {ok:true,status:200,json:async()=>({
     companyId:wrongCompany?5:1,runId:8,month:11,year:2026,effectiveThrough:"2026-11-30",
     source:"public.employees.salary",legacyAmountSemantics:"UNKNOWN",
     activeEmployees:2,withPositiveLegacyAmount:2,withoutEffectiveSalaryProfile:2,
     numericMatches:0,numericDifferences:0,
     legacyReferenceTotal:"9000000.00",configuredComparisonTotal:null,
     rows:[{employeeId:21,employeeName:"Karyawan Satu",legacySalary:"6000000.00",
       configuredBaseSalary:null,configuredAllowance:null,configuredTotal:null,
       differenceFromLegacy:null,effectiveFrom:null,status:"SALARY_COMPONENTS_NOT_CONFIGURED",
       componentsVerified:false},
       {employeeId:24,employeeName:"Karyawan Dua",legacySalary:"3000000.00",
        configuredBaseSalary:null,configuredAllowance:null,configuredTotal:null,
        differenceFromLegacy:null,effectiveFrom:null,status:"SALARY_COMPONENTS_NOT_CONFIGURED",
        componentsVerified:false}],
     readOnly:true,componentsVerified:false,canImport:false,canMaterialize:false,
     canApprove:false,canPost:false,canPay:false,note:"Nilai salary master belum memiliki komponen yang diverifikasi.",
   })} as Response;
 }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe("DEV legacy salary comparison UI",()=>{
 it("requires explicit read and displays unknown component meaning without write controls",async()=>{
   render(<PayrollLegacySalaryComparison companyId={1} runId={8}/>);
   expect(calls).toHaveLength(0);
   fireEvent.click(screen.getByRole("button",{name:"Bandingkan Nominal Master Gaji (Baca-saja)"}));
   await screen.findByText(/karyawan aktif: 2; nominal master tersedia: 2/);
   expect(screen.getByText(/Belum aman menganggap nominal master sebagai gaji pokok/)).toBeTruthy();
   expect(screen.getAllByText("Struktur gaji belum diisi")).toHaveLength(2);
   expect(screen.getByText("Karyawan Satu",{exact:false})).toBeTruthy();
   expect(screen.getByText("Karyawan Dua",{exact:false})).toBeTruthy();
   expect(screen.getByText(/Posting jurnal, persetujuan pembayaran, impor massal/)).toBeTruthy();
   expect(calls).toEqual([{url:"/api/payroll/runs/8/legacy-salary-comparison?companyId=1",method:"GET"}]);
   expect(screen.queryByRole("button",{name:/Simpan|Impor|Bayar|Posting/})).toBeNull();
 });
 it("rejects stale response from another company instead of showing salary data",async()=>{
   wrongCompany=true;
   render(<PayrollLegacySalaryComparison companyId={1} runId={8}/>);
   fireEvent.click(screen.getByRole("button",{name:"Bandingkan Nominal Master Gaji (Baca-saja)"}));
   await screen.findByRole("alert");
   expect(screen.getByRole("alert").textContent).toMatch(/Validasi pratinjau gaji\/perusahaan gagal/);
   expect(screen.queryByText("Karyawan Satu",{exact:false})).toBeNull();
   expect(calls.every(x=>x.method==="GET")).toBe(true);
 });
});
