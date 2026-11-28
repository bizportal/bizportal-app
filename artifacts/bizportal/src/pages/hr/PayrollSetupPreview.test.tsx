// @vitest-environment jsdom
import React from "react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {PayrollSetupPreview} from "./PayrollSetupPreview";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const props={companyId:1,runId:8,year:2026,month:11};
const payload={...props,readOnly:true,persisted:false,canMaterialize:false,readyForPayment:false,
  employeeCount:1,configuredCount:0,missingSalaryCount:1,missingDeductionConfigCount:1,invalidCount:0,
  rows:[{employeeId:21,employeeName:"QA Employee",gross:null,net:null,deductions:{kasbon_deduction:null},issues:["STRUKTUR_GAJI_BELUM_ADA"]}]};
describe("PayrollSetupPreview read-only UI",()=>{
  it("loads only on click and labels unknown salary instead of zero",async()=>{
    const request=vi.fn(async()=>({ok:true,json:async()=>payload}));vi.stubGlobal("fetch",request);
    render(<PayrollSetupPreview {...props}/>);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"Tampilkan pratinjau"}));
    expect(await screen.findByText("QA Employee")).toBeTruthy();
    expect(screen.getAllByText("Belum tersedia")).toHaveLength(3);
    expect(screen.getByText("Struktur gaji belum ada")).toBeTruthy();
    expect(request).toHaveBeenCalledWith("/api/payroll/runs/8/setup-preview?companyId=1",expect.objectContaining({credentials:"include",cache:"no-store"}));
    expect(screen.queryByText("Simpan")).toBeNull();
  });
  it("does not render a foreign or materializable response",async()=>{
    const request=vi.fn(async()=>({ok:true,json:async()=>({...payload,companyId:2})}));vi.stubGlobal("fetch",request);
    render(<PayrollSetupPreview {...props}/>);
    fireEvent.click(screen.getByRole("button",{name:"Tampilkan pratinjau"}));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(()=>expect(screen.queryByText("QA Employee")).toBeNull());
  });
});
