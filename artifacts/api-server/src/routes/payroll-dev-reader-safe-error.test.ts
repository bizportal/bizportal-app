import {describe,expect,it} from "vitest";
import {payrollDevReaderSafeReason,payrollDevReaderTransport} from "./payroll-dev-reader-safe-error";
describe("DEV Payroll reader diagnostic classification",()=>{
  it.each([
    ["postgresql://qa:example@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres","direct"],
    ["postgresql://qa:example@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres","session_pooler"],
    ["postgresql://qa:example@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres","transaction_pooler"],
    ["postgresql://qa:example@aws-1-ap-southeast-2.pooler.supabase.com:5444/postgres","unrecognized"],
    ["postgresql://qa:example@db.other.supabase.co:5432/postgres","unrecognized"],
    ["not a URL","unrecognized"],
    ["","not_configured"],
  ])("classifies transport without exposing the supplied URL", (url,kind)=>{
    expect(payrollDevReaderTransport(url)).toBe(kind);
  });
  it("returns a fixed fallback for unrecognized objects and arbitrary strings",()=>{
    expect(payrollDevReaderSafeReason("private fixture")).toBe("PAYROLL_DEV_DATABASE_OPERATION_FAILED");
    expect(payrollDevReaderSafeReason({code:"private fixture"})).toBe("PAYROLL_DEV_DATABASE_OPERATION_FAILED");
  });
});
