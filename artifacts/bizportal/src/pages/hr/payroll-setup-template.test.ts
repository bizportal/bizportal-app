import {describe,expect,it} from "vitest";
import {buildPayrollSetupBlankCsv} from "./payroll-setup-template";

describe("DEV Payroll salary setup planning export",()=>{
  it("exports only signed preview roster IDs and leaves every financial field blank",()=>{
    const csv=buildPayrollSetupBlankCsv(1,2026,11,[
      {employeeId:30,employeeName:"Agzi SC"},
      {employeeId:28,employeeName:"Robby Rahman"},
    ]);
    const lines=csv.replace(/^\uFEFF/,"").trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"kasbon_deduction"');
    expect(lines[1]).toBe('"1","30","Agzi SC","2026-11-01",'+Array(7).fill('""').join(","));
    expect(lines[2]).toBe('"1","28","Robby Rahman","2026-11-01",'+Array(7).fill('""').join(","));
    expect(csv).not.toContain('"0.00"');
    expect(csv).not.toContain("500000");
  });
  it("guards spreadsheet formulas and line breaks in source names",()=>{
    const csv=buildPayrollSetupBlankCsv(1,2026,11,[{employeeId:30,employeeName:'=HYPERLINK("evil")\nAdmin'}]);
    expect(csv).toContain('PERLINK(""evil"") Admin');
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv.split("\r\n")).toHaveLength(3);
  });
  it("rejects duplicate employee IDs, invalid scopes and never invents amounts",()=>{
    expect(()=>buildPayrollSetupBlankCsv(2,2026,11,[{employeeId:3,employeeName:"A"},{employeeId:3,employeeName:"B"}])).toThrow("INVALID_PAYROLL_TEMPLATE_EMPLOYEE");
    expect(()=>buildPayrollSetupBlankCsv(1,2026,13,[])).toThrow("INVALID_PAYROLL_TEMPLATE_SCOPE");
  });
});
