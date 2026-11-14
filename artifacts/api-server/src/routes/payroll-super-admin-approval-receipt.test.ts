import { describe, expect, it } from "vitest";
import {
  PAYROLL_SUPER_ADMIN_APPROVAL_MARKER,
  payrollSuperAdminApprovalDigest,
  readPayrollSuperAdminApprovalReceipt,
} from "./payroll-super-admin-approval-receipt";
import type { PayrollPreviewItem } from "./payroll-preview";

const item: PayrollPreviewItem = {
  id: 11, employeeId: 101,
  baseSalary: "5000000.00", allowance: "0.00",
  grossSalary: "5000000.00", bpjsJhtEmployee: "0.00",
  bpjsKesEmployee: "0.00", pph21: "0.00",
  otherDeductions: "0.00", kasbonDeduction: "100000.00",
  totalDeductions: "100000.00", netSalary: "4900000.00",
};
const receipt=(digest:string)=>PAYROLL_SUPER_ADMIN_APPROVAL_MARKER+" "+JSON.stringify({
  actorId:"verified-admin", actorEmail:"Super.Admin@example.test",digest,
  note:"Reviewed by one verified Super Admin",
});
describe("Super Admin approval receipt parser and digest (no approval write)",()=>{
  it("rejects old reviewed status without durable proof",()=>{
    expect(readPayrollSuperAdminApprovalReceipt("Reviewed by HR","2026-11-14","reviewed")).toBeNull();
    expect(readPayrollSuperAdminApprovalReceipt("Reviewed by Accounting","2026-11-14","approved")).toBeNull();
  });
  it("accepts only completed statuses with approved_at and valid marker",()=>{
    const digest=payrollSuperAdminApprovalDigest(1,32,[item]);
    const notes="Old note\n"+receipt(digest);
    expect(readPayrollSuperAdminApprovalReceipt(notes,"2026-11-14","reviewed")).toEqual({
      actorId:"verified-admin",actorEmail:"super.admin@example.test",
      digest,note:"Reviewed by one verified Super Admin",
    });
    for(const status of ["draft","pending","cancelled","rejected"]) {
      expect(readPayrollSuperAdminApprovalReceipt(notes,"2026-11-14",status)).toBeNull();
    }
    expect(readPayrollSuperAdminApprovalReceipt(notes,null,"approved")).toBeNull();
  });
  it("rejects forged invalid email, digest, note, and malformed JSON",()=>{
    const good=payrollSuperAdminApprovalDigest(1,32,[item]);
    const cases=[
      {actorId:"",actorEmail:"admin@example.test",digest:good,note:"Valid sufficient note"},
      {actorId:"admin",actorEmail:"not-an-email",digest:good,note:"Valid sufficient note"},
      {actorId:"admin",actorEmail:"admin@example.test",digest:"bad",note:"Valid sufficient note"},
      {actorId:"admin",actorEmail:"admin@example.test",digest:good,note:"short"},
    ];
    for(const obj of cases)expect(readPayrollSuperAdminApprovalReceipt(
      PAYROLL_SUPER_ADMIN_APPROVAL_MARKER+" "+JSON.stringify(obj),"2026-11-14","approved",
    )).toBeNull();
    expect(readPayrollSuperAdminApprovalReceipt(
      PAYROLL_SUPER_ADMIN_APPROVAL_MARKER+" {broken-json","2026-11-14","paid",
    )).toBeNull();
  });
  it("binds digest deterministically to exact run, company and persisted item",()=>{
    const a=payrollSuperAdminApprovalDigest(1,32,[item]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(payrollSuperAdminApprovalDigest(1,32,[item]));
    expect(a).not.toBe(payrollSuperAdminApprovalDigest(2,32,[item]));
    expect(a).not.toBe(payrollSuperAdminApprovalDigest(1,33,[item]));
    expect(a).not.toBe(payrollSuperAdminApprovalDigest(1,32,[{...item,kasbonDeduction:"50000.00"}]));
  });
});
