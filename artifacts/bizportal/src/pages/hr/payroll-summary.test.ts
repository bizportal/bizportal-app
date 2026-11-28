import {describe,it,expect} from "vitest";
import {summarizePersistedPayrollItems} from "./payroll-summary";

describe("persisted Payroll summary must not make missing wages look like Rp0",()=>{
  it("reports no totals when a Draft has no saved Payroll items",()=>{
    expect(summarizePersistedPayrollItems([])).toEqual({
      itemCount:0,gross:null,advances:null,net:null,
    });
  });
  it("keeps legitimate explicit zero amounts if a saved item exists",()=>{
    expect(summarizePersistedPayrollItems([{item:{
      grossSalary:"0.00",kasbonDeduction:"0.00",netSalary:"0.00",
    }}])).toEqual({itemCount:1,gross:0,advances:0,net:0});
  });
  it("sums only actual stored payroll items, not HRD candidates",()=>{
    const s=summarizePersistedPayrollItems([
      {item:{grossSalary:"5000000.00",kasbonDeduction:"0.00",netSalary:"4850000.00"}},
      {item:{grossSalary:"4000000.00",kasbonDeduction:"250000.00",netSalary:"3600000.00"}},
    ]);
    expect(s).toEqual({itemCount:2,gross:9000000,advances:250000,net:8450000});
  });
  it.each(["","undefined","Infinity","NaN","oops","5e6"])("never substitutes zero for missing or invalid source money %s",v=>{
    const s=summarizePersistedPayrollItems([{item:{grossSalary:v,kasbonDeduction:"0",netSalary:"0"}}]);
    expect(s).toEqual({itemCount:1,gross:null,advances:null,net:null});
  });
  it("does not fabricate a valid total from arithmetic overflow",()=>{
    const s=summarizePersistedPayrollItems([
      {item:{grossSalary:"99999999999999999999999999999.00",kasbonDeduction:"0",netSalary:"99999999999999999999999999999.00"}},
    ]);
    // A value outside JS exact currency bounds must never be treated as Rp0.
    expect(s.gross).not.toBe(0);
  });
});
