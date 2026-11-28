// @vitest-environment jsdom
import React from "react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {previewDailySourcePaste} from "./payroll-daily-source-paste";
import {PayrollDailySourceReference} from "./PayrollDailySourceReference";
const head="NO\tNAMA\tUANG MAKAN\tHari Kerja\tPERSENTASE\tTotal Salary";
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe("read-only daily salary source paste",()=>{
  it("keeps repeated headers, blank and total lines, exact row locations, missing amounts and fractional rates",()=>{
    const rows=[head,"1\tFixture A\t1.000.000\t26\t57.692,3\t1.499.999,80","TOTAL\t\t\t\t\t","",""+head,"1\tFixture B\t\t\t\t5.000.000"].join("\n");
    const p=previewDailySourcePaste(rows,"id",2026,11);
    expect(p).toMatchObject({employeeRows:2,dailyArithmeticMatches:1,withoutVerifiedDailyBasis:1,missingMealAllowance:1,canMaterialize:false});
    expect(p.rows[0]).toMatchObject({rowNumber:2,arithmeticMatch:true,computedDailySalaryReference:"1499999.80",baseSalary:null,netSalary:null});
    expect(p.rows[1]).toMatchObject({rowNumber:6,mealAllowanceReference:null,netSalary:null,arithmeticMatch:null});
  });
  it("handles raw and international formats only when explicitly selected",()=>{
    expect(previewDailySourcePaste(head+"\n1\tFixture\t1000000\t26\t57692.3\t1499999.80","raw",2026,11).dailyArithmeticMatches).toBe(1);
    expect(previewDailySourcePaste(head+"\n1\tFixture\t1,000,000\t26\t57,692.3\t1,499,999.80","en",2026,11).dailyArithmeticMatches).toBe(1);
    expect(()=>previewDailySourcePaste(head+"\n1\tFixture\t1,000,000\t26\t57,692.3\t1,499,999.80","id",2026,11)).toThrow();
  });
  it("rejects wrong headers, extra sensitive columns, invalid days and missing totals",()=>{
    for(const input of ["NO\tNAME\tUANG MAKAN\tHari Kerja\tPERSENTASE\tTotal Salary\n1\tX\t1\t26\t1\t26",head+"\n1\tX\t1\t26\t1\t26\textra",head+"\n1\tX\t1\t31\t1\t31",head+"\n1\tX\t1\t26\t1\t"])
      expect(()=>previewDailySourcePaste(input,"raw",2026,11)).toThrow();
  });
  it("renders a local preview, clears stale result on edit and never sends data",()=>{
    const request=vi.fn();vi.stubGlobal("fetch",request);
    render(<PayrollDailySourceReference year={2026} month={11}/>);
    fireEvent.change(screen.getByRole("textbox",{name:"Sumber tarif harian"}),{target:{value:head+"\n1\tFixture UI\t1000\t26\t100\t2600"}});
    fireEvent.click(screen.getByRole("button",{name:"Periksa Sumber Gaji"}));
    expect(screen.getByRole("status").textContent).toContain("1 rumus cocok");
    expect(screen.getByText(/Fixture UI/)).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox",{name:"Sumber tarif harian"}),{target:{value:head}});
    expect(screen.queryByText(/Fixture UI/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
