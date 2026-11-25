import React from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
const fixture=vi.hoisted(()=>({companyId:1,anonymous:false,scopeRequired:false,verified:false,
  posts:0,result:null as any}));
vi.mock("@/components/layout/AppShell",()=>({AppShell:({children}:{children:React.ReactNode})=><div>{children}</div>}));
vi.mock("@/contexts/CompanyContext",()=>({useCompany:()=>({activeCompanyId:fixture.companyId})}));
vi.mock("@/pages/purchase/FinanceCompanyScopeCard",()=>({
 FinanceCompanyScopeCard:()=> <div>Verifikasi perusahaan Finance (DEV)</div>,
}));
vi.mock("wouter",()=>({Link:({children,href}:any)=><a href={href}>{children}</a>}));
import Page from "@/pages/finance/po14-e2e-qa";
const mockResponse=(body:unknown,status=200)=>({
  ok:status>=200&&status<300,status,json:async()=>body,
});
const payload=()=>({sandbox:true,bankTransfer:false,businessLedgerPosted:false,
  actualBankReconcilerExecuted:false,actualVendorInvoiceCreated:false,
  result:fixture.result});
describe("PO14 page is explicitly simulation-only and uses signed QA endpoint",()=>{
 beforeEach(()=>{
  fixture.companyId=1;fixture.anonymous=false;fixture.scopeRequired=false;
  fixture.verified=false;fixture.posts=0;fixture.result=null;
  vi.stubGlobal("fetch",vi.fn(async(url:string,options?:RequestInit)=>{
   if(url==="/api/mkt/admin/finance-company-selection"){
     fixture.verified=true;return mockResponse({ok:true,companyId:1});
   }
   if(url!=="/api/mkt/admin/po14-e2e-qa")throw Error("Unexpected URL");
   if(fixture.anonymous)return mockResponse({error:"Sesi Super Admin diperlukan"},401);
   if(fixture.scopeRequired&&!fixture.verified)return mockResponse({error:"Finance scope"},403);
   if(options?.method==="POST"){
     fixture.posts++;
     expect(JSON.parse(String(options.body))).toEqual({reference:"PO-20261117-00014"});
     fixture.result={
       id:1,reference:"PO-20261117-00014",companyId:1,
       actor:"owner@qa.invalid",status:"completed",amount:"100000.00",auditCount:1,
       createdAt:"2026-11-25T10:30:00Z",steps:[
        {stage:"PO / GR referensi",status:"SIMULATED",reference:"PO #14 / GR #6"},
        {stage:"Vendor Invoice",status:"SIMULATED",reference:"Tanpa hutang bisnis"},
       ],
     };
   }
   return mockResponse(payload());
  }));
 });
 afterEach(()=>{cleanup();vi.unstubAllGlobals();});
 it("shows clearly labelled simulation, records only QA and a replay button",async()=>{
   render(<Page/>);
   const button=await screen.findByRole("button",{name:"Jalankan Simulasi E2E PO #14"});
   expect(document.body.textContent).toContain("Tidak membuat GL bisnis");
   fireEvent.click(button);
   await screen.findByText(/Bukti simulasi tercatat/);
   expect(fixture.posts).toBe(1);
   expect(screen.getAllByText("SIMULATED")).toHaveLength(2);
   expect(screen.getByRole("button",{name:"Ulangi pemeriksaan (replay aman)"})).toBeTruthy();
 });
 it("recovers finance company scope and then shows the button",async()=>{
   fixture.scopeRequired=true;
   render(<Page/>);
   const button=await screen.findByRole("button",{name:"Jalankan Simulasi E2E PO #14"});
   expect(button).toBeTruthy();
   expect(fixture.verified).toBe(true);
 });
 it("refuses to provide the action for an anonymous browser",async()=>{
   fixture.anonymous=true;
   render(<Page/>);
   expect(await screen.findByRole("alert")).toBeTruthy();
   expect(screen.queryByRole("button",{name:"Jalankan Simulasi E2E PO #14"})).toBeNull();
   expect(fixture.posts).toBe(0);
 });
 it("prevents CST test execution under another company selection",async()=>{
   fixture.companyId=3;
   render(<Page/>);
   await screen.findByText("Verifikasi perusahaan Finance (DEV)");
   expect(screen.queryByRole("button",{name:"Jalankan Simulasi E2E PO #14"})).toBeNull();
 });
});
