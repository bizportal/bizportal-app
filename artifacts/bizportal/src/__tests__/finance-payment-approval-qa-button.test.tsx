import React from "react";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
const fixture=vi.hoisted(()=>({status:"pending",company:1,post:0,anonymous:false,
    needsScope:false,scopeConfirmed:false,scopePosts:0}));
vi.mock("@/components/layout/AppShell",()=>({AppShell:({children}:{children:React.ReactNode})=><div>{children}</div>}));
vi.mock("@/contexts/CompanyContext",()=>({useCompany:()=>({activeCompanyId:fixture.company})}));
vi.mock("@/pages/purchase/FinanceCompanyScopeCard",()=>({
 FinanceCompanyScopeCard:()=> <div>Verifikasi perusahaan Finance (DEV)</div>,
}));
vi.mock("wouter",()=>({Link:({children,href}:any)=><a href={href}>{children}</a>}));
import FinancePaymentApprovalQa from "@/pages/finance/payment-approval-qa";
function response(body:unknown,status=200):Response{
 return {status,ok:status>=200&&status<300,json:async()=>body} as Response;
}
describe("visible signed Super Admin E2E approval QA button",()=>{
 beforeEach(()=>{
  fixture.status="pending";fixture.company=1;fixture.post=0;fixture.anonymous=false;
  fixture.needsScope=false;fixture.scopeConfirmed=false;fixture.scopePosts=0;
  vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=String(input);
   if(url==="/api/mkt/admin/finance-company-selection" && init?.method==="POST"){
     fixture.scopePosts++;
     const chosen=JSON.parse(String(init.body)).companyId;
     if(chosen!==fixture.company)return response({error:"Company mismatch"},403);
     fixture.scopeConfirmed=true;
     return response({ok:true,companyId:chosen});
   }
   if(url!=="/api/mkt/admin/payment-approval-qa")throw Error("Unexpected URL: "+url);
   if(fixture.anonymous)return response({error:"Sesi Super Admin diperlukan"},401);
   if(fixture.needsScope&&!fixture.scopeConfirmed)return response({error:"Pilih dan verifikasi perusahaan Finance"},403);
   if(init?.method==="POST"){
    fixture.post++;
    if(JSON.parse(String(init.body)).scenarioId!==9001)throw Error("Wrong QA ID");
    fixture.status="approved";
    return response({ok:true,status:"approved",replay:false,
     reference:"QA-FINANCE-CST-20261120",sandbox:true,bankTransfer:false,glPosted:false});
   }
   return response({scenario:{id:9001,companyId:1,reference:"QA-FINANCE-CST-20261120",
    amount:"1000.00",status:fixture.status,approvedAt:null},
    sandbox:true,bankTransfer:false,glPosted:false});
  }));
 });
 afterEach(()=>{cleanup();vi.unstubAllGlobals()});
 it("renders an actionable button, sends one approval and shows the QA receipt",async()=>{
  render(<FinancePaymentApprovalQa/>);
  const button=await screen.findByRole("button",{name:"Setujui Pembayaran Uji"});
  expect(button).toBeTruthy();
  expect(document.body.textContent).toContain("Perusahaan Finance sudah diverifikasi oleh server");
  fireEvent.click(button);
  await screen.findByText(/PASS — QA-FINANCE-CST-20261120/);
  expect(fixture.post).toBe(1);
  const approved=screen.getByRole("button",{name:"Persetujuan QA tercatat"});
  expect((approved as HTMLButtonElement).disabled).toBe(true);
  expect(document.body.textContent).toContain("Ini bukan");
 });
 it("recovers automatically from missing signed company scope, then enables the real QA action",async()=>{
  fixture.needsScope=true;
  render(<FinancePaymentApprovalQa/>);
  const button=await screen.findByRole("button",{name:"Setujui Pembayaran Uji"});
  expect(button).toBeTruthy();
  expect(fixture.scopePosts).toBe(1);
  fireEvent.click(button);
  await screen.findByText(/PASS — QA-FINANCE-CST-20261120/);
  expect(fixture.post).toBe(1);
 });
 it("never attempts company verification for an anonymous session",async()=>{
  fixture.anonymous=true;
  fixture.needsScope=true;
  render(<FinancePaymentApprovalQa/>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(fixture.scopePosts).toBe(0);
  expect(fixture.post).toBe(0);
 });
 it("does not auto-verify a company outside the sandbox allowlist",async()=>{
  fixture.company=99;
  fixture.needsScope=true;
  render(<FinancePaymentApprovalQa/>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(fixture.scopePosts).toBe(0);
  expect(screen.queryByRole("button",{name:"Setujui Pembayaran Uji"})).toBeNull();
 });
 it("refuses to show an approval action without an authenticated server response",async()=>{
  fixture.anonymous=true;
  render(<FinancePaymentApprovalQa/>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Setujui Pembayaran Uji"})).toBeNull();
  expect(fixture.post).toBe(0);
 });
});
