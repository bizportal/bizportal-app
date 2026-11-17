import { describe, expect, it } from "vitest";
import { prepareReviewedPayrollAccrual, type PayrollHandoffInput } from "./payroll-accounting-handoff";
import { PAYROLL_SUPER_ADMIN_APPROVAL_MARKER, payrollSuperAdminApprovalDigest } from "./payroll-super-admin-approval-receipt";

function sign(input: PayrollHandoffInput) {
  const items = input.items.map(({ isPaid: _paid, ...item }) => item).sort((a, b) => a.id - b.id);
  input.run.notes = PAYROLL_SUPER_ADMIN_APPROVAL_MARKER + " " + JSON.stringify({
    actorId: "synthetic-super-admin", actorEmail: "admin@example.test",
    digest: payrollSuperAdminApprovalDigest(input.companyId, input.run.id, items),
    note: "Approved synthetic payroll for isolated test only",
  });
  return input;
}
function fixture(): PayrollHandoffInput {
  return sign({
    companyId: 1, postingDate: "2026-11-17",
    run: { id: 32, companyId: 1, year: 2026, month: 11, status: "reviewed", postingStatus: "pending",
      approvedAt: "2026-11-17T10:00:00Z", notes: null, accountingEntryId: null, paymentEntryId: null },
    activeEmployeeIds: [101],
    items: [{ id: 11, employeeId: 101, baseSalary: "5000000.00", allowance: "200000.00",
      grossSalary: "5200000.00", bpjsJhtEmployee: "100000.00", bpjsKesEmployee: "50000.00",
      pph21: "50000.00", otherDeductions: "0.00", kasbonDeduction: "100000.00",
      totalDeductions: "300000.00", netSalary: "4900000.00", isPaid: false }],
    reservations: [{ companyId: 1, runId: 32, advanceId: 801, receivableAccountId: 14,
      payrollItemId: 11, employeeId: 101, amount: "100000.00", heldBalance: "500000.00",
      currentBalance: "500000.00", advanceStatus: "partial", advanceLifecycle: "partially_settled",
      advanceApprovedAt: "2026-10-01", advanceApprovedBy: "synthetic",
      advanceDisbursedAt: "2026-10-02", advanceDisbursedBy: "synthetic",
      advanceAccountingEntryId: 91, advancePostingStatus: "posted", advanceVoidedAt: null, state: "prepared" }],
    mapping: { salaryExpenseAccountId: 10, allowanceExpenseAccountId: 10,
      salaryPayableAccountId: 11, taxPayableAccountId: 12, bpjsPayableAccountId: 13 },
    accounts: [10, 11, 12, 13, 14].map(id => ({ id, companyId: 1,
      type: id === 10 ? "expense" : id === 14 ? "asset" : "liability",
      isActive: true, isPostable: true, isHeader: false, status: "ACTIVE" })),
  });
}

describe("reviewed Payroll handoff to existing accrual service — read-only", () => {
  it("prepares original service inputs without resetting reviewed or invoking a writer", () => {
    const input = fixture(), before = structuredClone(input);
    const plan = prepareReviewedPayrollAccrual(input);
    expect(plan).toMatchObject({ source: "payroll", sourceId: 32, reference: "PAYROLL-32",
      expectedStatus: "reviewed", nextStatus: "approved", readOnly: true,
      requiresAtomicPosting: true, accountingPosted: false, readyForPayment: false,
      debitTotal: "5200000.00", creditTotal: "5200000.00",
      params: { companyId: 1, payrollRunId: 32, totalSalary: 5000000, totalAllowance: 200000,
        totalTax: 50000, totalBpjs: 150000, totalSalaryPayable: 4900000,
        kasbonByAccount: [{ accountId: 14, amount: 100000 }] } });
    expect(input).toEqual(before);
    expect(plan.approvedAt).toBe(input.run.approvedAt);
    expect(plan.approvalReceipt.actorId).toBe("synthetic-super-admin");
  });

  it("handles a complete 17-person synthetic roster with unchanged approval digest", () => {
    const input = fixture(), first = input.items[0]!;
    input.items = Array.from({ length: 17 }, (_, n) => ({ ...first, id: 11 + n, employeeId: 101 + n,
      kasbonDeduction: "0.00", totalDeductions: "200000.00", netSalary: "5000000.00" }));
    input.activeEmployeeIds = input.items.map(i => i.employeeId);
    input.reservations = [];
    const plan = prepareReviewedPayrollAccrual(sign(input));
    expect(plan.debitTotal).toBe("88400000.00");
    expect(plan.creditTotal).toBe("88400000.00");
    expect(plan.params.totalSalaryPayable).toBe(85000000);
    expect(plan.params.kasbonByAccount).toEqual([]);
  });

  it.each(["draft", "calculated", "approved", "paid", "cancelled"])("does not convert %s to an approved handoff", status => {
    const input = fixture(); input.run.status = status;
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("RUN_NOT_UNPOSTED_REVIEWED");
  });
  it.each(["processing", "posted", "error"])("rejects a %s posting state", status => {
    const input = fixture(); input.run.postingStatus = status;
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("RUN_NOT_UNPOSTED_REVIEWED");
  });
  it.each(["accountingEntryId", "paymentEntryId"] as const)("blocks a previously linked %s instead of reposting", field => {
    const input = fixture(); input.run[field] = 91;
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("RUN_NOT_UNPOSTED_REVIEWED");
  });
  it("preserves historical reviewed rows without treating them as Super Admin approval", () => {
    const input = fixture(); input.run.notes = "HR reviewed historically";
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("VERIFIED_RECEIPT_REQUIRED");
    input.run.notes = PAYROLL_SUPER_ADMIN_APPROVAL_MARKER + " invalid";
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("VERIFIED_RECEIPT_REQUIRED");
  });
  it.each([null, "not-a-date"])("rejects missing or invalid approval date (%s)", date => {
    const input = fixture(); input.run.approvedAt = date;
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("APPROVAL_DATE_INVALID");
  });
  it("rejects updated salaries after receipt without rewriting the approved digest", () => {
    const input = fixture(); input.items = input.items.map(i => ({ ...i,
      baseSalary: "5000001.00", grossSalary: "5200001.00", netSalary: "4900001.00" }));
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("APPROVED_DATA_CHANGED");
  });
  it("rejects arithmetically incorrect persisted totals", () => {
    const input = fixture(); input.items = input.items.map(i => ({ ...i, netSalary: "1.00" }));
    expect(() => prepareReviewedPayrollAccrual(sign(input))).toThrow("TOTALS_MISMATCH");
  });
  it("requires exact company scope", () => {
    const input = fixture(); input.companyId = 2;
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("COMPANY_SCOPE_INVALID");
  });
  it("rejects incomplete or duplicate active employee coverage", () => {
    const input = fixture(); input.activeEmployeeIds = [101, 102];
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("EMPLOYEE_COVERAGE_OR_PAYMENT_INVALID");
    input.activeEmployeeIds = [101, 101];
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("EMPLOYEE_COVERAGE_OR_PAYMENT_INVALID");
  });
  it("rejects already-paid employee items", () => {
    const input = fixture(); input.items = input.items.map(i => ({ ...i, isPaid: true }));
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("EMPLOYEE_COVERAGE_OR_PAYMENT_INVALID");
  });
  it.each([
    { companyId: 2 }, { isActive: false }, { isPostable: false },
    { isHeader: true }, { status: "INACTIVE" }, { type: "asset" },
  ])("rejects wrong or unusable salary COA metadata %j", mutation => {
    const input = fixture(); input.accounts = input.accounts.map(a => a.id === 10 ? { ...a, ...mutation } : a);
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("ACCOUNT_MAPPING_INVALID");
  });
  it("requires the explicit BPJS liability account even when current BPJS value is zero", () => {
    const input = fixture(); input.accounts = input.accounts.filter(a => a.id !== 13);
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("ACCOUNT_MAPPING_INVALID");
  });
  it("blocks unrepresented other deductions rather than producing an unbalanced journal", () => {
    const input = fixture(); input.items = input.items.map(i => ({ ...i, otherDeductions: "1.00",
      totalDeductions: "300001.00", netSalary: "4899999.00" }));
    expect(() => prepareReviewedPayrollAccrual(sign(input))).toThrow("OTHER_DEDUCTION_MAPPING_REQUIRED");
  });
  it.each(["0.01", "1.00", "150000.50"])("includes mapped other deduction %s without hiding or rounding it", value => {
    const input = fixture();
    const cents = Math.round(Number(value) * 100);
    input.items = input.items.map(i => ({ ...i, otherDeductions: value,
      totalDeductions: ((30000000 + cents) / 100).toFixed(2), netSalary: ((490000000 - cents) / 100).toFixed(2) }));
    input.mapping.otherDeductionPayableAccountId = 15;
    input.accounts = [...input.accounts, { id: 15, companyId: 1, type: "liability",
      isActive: true, isPostable: true, isHeader: false, status: "ACTIVE" }];
    const plan = prepareReviewedPayrollAccrual(sign(input));
    expect(plan.params.totalOtherDeductions).toBe(Number(value));
    expect(plan.params.totalSalaryPayable).toBe(Number(input.items[0]!.netSalary));
    expect(plan.debitTotal).toBe("5200000.00");expect(plan.creditTotal).toBe(plan.debitTotal);
    expect(plan.params.kasbonByAccount).toEqual([{ accountId: 14, amount: 100000 }]);
    expect(plan.mapping.otherDeductionPayableAccountId).toBe(15);
  });
  it.each([{companyId:2},{type:"expense"},{type:"asset"},{isActive:false},{isPostable:false},{isHeader:true},{status:"INACTIVE"}])
    ("rejects wrong other-deduction account metadata %j", mutation => {
      const input = fixture();
      input.items = input.items.map(i => ({ ...i,otherDeductions:"1.00",totalDeductions:"300001.00",netSalary:"4899999.00" }));
      input.mapping.otherDeductionPayableAccountId=15;
      input.accounts=[...input.accounts,{id:15,companyId:1,type:"liability",isActive:true,isPostable:true,isHeader:false,status:"ACTIVE",...mutation}];
      expect(()=>prepareReviewedPayrollAccrual(sign(input))).toThrow("ACCOUNT_MAPPING_INVALID");
    });
  it("preserves the zero-other-deduction contract without requiring a new account", () => {
    const plan=prepareReviewedPayrollAccrual(fixture());
    expect(plan.params).not.toHaveProperty("totalOtherDeductions");
    expect(plan.mapping).not.toHaveProperty("otherDeductionPayableAccountId");
  });
  it("refuses a nonzero deduction if the explicitly mapped account is absent", () => {
    const input=fixture();input.mapping.otherDeductionPayableAccountId=15;
    input.items=input.items.map(i=>({...i,otherDeductions:"1.00",totalDeductions:"300001.00",netSalary:"4899999.00"}));
    expect(()=>prepareReviewedPayrollAccrual(sign(input))).toThrow("ACCOUNT_MAPPING_INVALID");
  });
  it("rejects missing or changed kasbon evidence and does not settle balances", () => {
    const input = fixture(); input.reservations = [];
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("KASBON_RESERVATIONS_INVALID");
    const changed = fixture(); changed.reservations = changed.reservations.map(r => ({ ...r, currentBalance: "400000.00" }));
    expect(() => prepareReviewedPayrollAccrual(changed)).toThrow("KASBON_RESERVATIONS_INVALID");
  });
  it("rejects repeated advance ids and cross-run reservation rows", () => {
    const input = fixture(); input.reservations = [...input.reservations, ...input.reservations];
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("RESERVATION_SCOPE_OR_DUPLICATE");
    input.reservations = [{ ...input.reservations[0]!, runId: 33 }];
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("RESERVATION_SCOPE_OR_DUPLICATE");
  });
  it("rejects a reservation greater than its balance", () => {
    const input = fixture(); input.reservations = input.reservations.map(r => ({ ...r,
      amount: "600000.00", currentBalance: "500000.00", heldBalance: "500000.00" }));
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("RESERVATION_EXCEEDS_BALANCE");
  });
  it.each(["2026-02-30", "17/11/2026", "2026-11-17T00:00:00Z"])("rejects invalid calendar date %s", date => {
    const input = fixture(); input.postingDate = date;
    expect(() => prepareReviewedPayrollAccrual(input)).toThrow("POSTING_DATE_INVALID");
  });
});
