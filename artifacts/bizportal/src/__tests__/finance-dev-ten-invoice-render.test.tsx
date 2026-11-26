import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  companyId: 1,
  company: { id: 1, companyName: "PT Cahaya Sejati Teknologi" },
  verified: false,
  calls: [] as Array<{path:string,method:string}>,
}));
vi.mock("wouter", () => ({
  Link: ({children,...props}:any) => React.createElement("a",props,children),
  useLocation: () => ["/purchase/vendor-invoices", vi.fn()],
  useParams: () => ({}),
  useSearch: () => "",
}));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    activeCompanyId:state.companyId,activeCompany:state.company,
    isConsolidated:false,isLoading:false,refetch:vi.fn(),
  }),
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({children}:{children:React.ReactNode}) => <div>{children}</div>,
}));
vi.mock("sonner", () => ({toast:{success:vi.fn(),error:vi.fn()}}));
import { VendorInvoicesListPage } from "@/pages/purchase/vendor-invoices";

const invoices=Array.from({length:10},(_,i)=>({
 id:i+1, invoiceNumber:"CST-VI-"+String(i+1).padStart(2,"0"),
 supplierName:"Supplier QA "+(i+1), status:i<8?"draft":"posted",
 grandTotal:1000+i, invoiceSource:"legacy_unlinked",
 threeWayMatchStatus:"unmatched",companyId:1,invoiceDate:"2026-11-19",
 amountPaid:null,reconciledAmountPaid:null,pphPaidAmount:null,
}));
function response(body: unknown, status=200): Response {
 return {ok:status>=200&&status<300,status,json:async()=>body} as Response;
}

describe("Finance DEV signed scoped list browser rendering",()=>{
 beforeEach(()=>{
  state.companyId=1;state.company={id:1,companyName:"PT Cahaya Sejati Teknologi"};
  state.verified=false;state.calls=[];
  vi.stubEnv("VITE_BIZPORTAL_FINANCE_GLOBAL_SCOPE_UI_DEV","true");
  vi.stubEnv("VITE_BIZPORTAL_FINANCE_READONLY_PREVIEW_DEV","false");
  vi.stubGlobal("fetch",vi.fn(async (input:RequestInfo|URL, init?:RequestInit)=>{
    const path=String(input),method=init?.method??"GET";
    state.calls.push({path,method});
    if(path==="/api/mkt/admin/finance-company-selection"&&method==="POST"){
      const companyId=JSON.parse(String(init?.body)).companyId;
      state.verified=true;return response({ok:true,companyId});
    }
    if(path.startsWith("/api/mkt/admin/vendor-invoices?")){
      const companyId=Number(new URL(path,"https://preview.invalid").searchParams.get("company"));
      if(!state.verified) return response({error:"Company scope not verified"},403);
      if(companyId!==state.companyId) return response({error:"scope mismatch"},403);
      const data=companyId===1?invoices:[];
      return response({data,page:1,pageSize:50,total:data.length,hasMore:false,
        mode:"company_finance_dev_read_only"});
    }
    if(path.includes("legacy-withholding-repairs"))return response({data:[],total:0});
    throw Error("Unexpected request path");
  }));
 });
 afterEach(()=>{cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals()});
 it("recovers from pre-verification 403 to 10 rows (8 draft, 2 posted) and never offers financial mutations",async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  const {container}=render(<QueryClientProvider client={client}><VendorInvoicesListPage /></QueryClientProvider>);
  expect(await screen.findByText(/Company scope not verified/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Verifikasi perusahaan Finance"}));
  expect(await screen.findByText(/Perusahaan telah diverifikasi oleh server/)).toBeTruthy();
  await waitFor(()=>expect(container.querySelectorAll("tbody tr")).toHaveLength(10));
  expect(container.querySelectorAll("tbody tr")).toHaveLength(10);
  const rows=Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"));
  expect(rows.filter(row=>within(row).queryByText("draft"))).toHaveLength(8);
  expect(rows.filter(row=>within(row).queryByText("posted"))).toHaveLength(2);
  expect(screen.getAllByText("Historis — tanpa PO")).toHaveLength(10);
  expect(screen.getAllByText("Baca saja")).toHaveLength(10);
  expect(screen.queryByText(/Gagal memuat vendor invoice/)).toBeNull();
  expect(state.calls.some(c=>c.path.startsWith("/api/purchase-workflow/vendor-invoices"))).toBe(false);
  expect(state.calls.filter(c=>c.method==="POST").map(c=>c.path)).toEqual([
    "/api/mkt/admin/finance-company-selection",
  ]);
  client.clear();
 });
 it("Diva renders zero CST invoice rows from its company-scoped response",async()=>{
  state.companyId=3;state.company={id:3,companyName:"PT Diva Servis"};
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const {container}=render(<QueryClientProvider client={client}><VendorInvoicesListPage /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button",{name:"Verifikasi perusahaan Finance"}));
  await screen.findByText(/Perusahaan telah diverifikasi oleh server/);
  await screen.findByText("Belum ada vendor invoice");
  expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
  expect(state.calls.filter(c=>c.path.includes("/api/mkt/admin/vendor-invoices?")).every(c=>c.path.includes("company=3"))).toBe(true);
  client.clear();
 });
});
