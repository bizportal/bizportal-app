import { buildPayrollPreview, type PayrollPreviewItem } from "./payroll-preview";
import { centsToMoney, moneyToCents, payrollMonth } from "./payroll-kasbon-automatic";
import { kasbonReviewMatchesReservations } from "./payroll-kasbon-hr-review-guard";
import {
  payrollSuperAdminApprovalDigest,
  readPayrollSuperAdminApprovalReceipt,
} from "./payroll-super-admin-approval-receipt";

/** Pure preflight for the EXISTING PayrollJournalService.postAccrualJournal.
 * Does not call a writer, add a route, grant rights, approve, settle, or pay.
 * The caller must obtain these rows under authenticated company scope and an
 * atomic posting transaction, revalidate after locking, and use the existing
 * accounting writer with that SAME transaction. A receipt is not a session.
 * Historical unsigned HR `reviewed` rows are never upgraded automatically.
 */
export type PayrollAccrualMapping = {
  salaryExpenseAccountId: number;
  allowanceExpenseAccountId: number;
  salaryPayableAccountId: number;
  taxPayableAccountId: number;
  bpjsPayableAccountId: number;
  /** Optional unless a nonzero other deduction is explicitly mapped by company. */
  otherDeductionPayableAccountId?: number;
};
export type PayrollHandoffAccount = {
  id: number; companyId: number; type: string; isActive: boolean;
  isPostable: boolean; isHeader: boolean; status: string;
};
type Reservation = Parameters<typeof kasbonReviewMatchesReservations>[1][number];
export type PayrollHandoffReservation = Reservation & {
  companyId: number; runId: number; advanceId: number; receivableAccountId: number;
};
export type PayrollHandoffInput = {
  companyId: number;
  postingDate: string;
  run: {
    id: number; companyId: number; year: number; month: number;
    status: string; postingStatus: string; approvedAt: string | Date | null;
    notes: string | null; accountingEntryId: number | null; paymentEntryId: number | null;
  };
  activeEmployeeIds: readonly number[];
  items: readonly (PayrollPreviewItem & { isPaid: boolean })[];
  reservations: readonly PayrollHandoffReservation[];
  mapping: PayrollAccrualMapping;
  accounts: readonly PayrollHandoffAccount[];
};

function reject(code: string): never { throw Error("PAYROLL_HANDOFF_" + code); }
const validId = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
function asLegacyAmount(cents: bigint): number {
  if (cents < 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) reject("AMOUNT_OUT_OF_RANGE");
  const amount = Number(cents) / 100;
  // The legacy writer takes numbers; never silently lose a cent at its boundary.
  if (moneyToCents(amount.toFixed(2)) !== cents) reject("AMOUNT_PRECISION_LOSS");
  return amount;
}
function normalizeItem(i: PayrollPreviewItem): PayrollPreviewItem {
  // Identical field order to the existing approval endpoint's digest payload.
  return {
    id: i.id, employeeId: i.employeeId, baseSalary: i.baseSalary, allowance: i.allowance,
    grossSalary: i.grossSalary, bpjsJhtEmployee: i.bpjsJhtEmployee,
    bpjsKesEmployee: i.bpjsKesEmployee, pph21: i.pph21,
    otherDeductions: i.otherDeductions, kasbonDeduction: i.kasbonDeduction,
    totalDeductions: i.totalDeductions, netSalary: i.netSalary,
  };
}

export function prepareReviewedPayrollAccrual(input: PayrollHandoffInput) {
  const { companyId, run, mapping, accounts, reservations } = input;
  if (!validId(companyId) || !validId(run.id) || run.companyId !== companyId)
    reject("COMPANY_SCOPE_INVALID");
  if (run.status !== "reviewed" || run.postingStatus !== "pending" ||
      run.accountingEntryId !== null || run.paymentEntryId !== null)
    reject("RUN_NOT_UNPOSTED_REVIEWED");
  if (!run.approvedAt || !Number.isFinite(new Date(run.approvedAt).getTime()))
    reject("APPROVAL_DATE_INVALID");
  const receipt = readPayrollSuperAdminApprovalReceipt(run.notes, run.approvedAt, run.status);
  if (!receipt) reject("VERIFIED_RECEIPT_REQUIRED");
  const period = payrollMonth(run.year, run.month).slice(0, 7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.postingDate) ||
      !Number.isFinite(Date.parse(input.postingDate + "T00:00:00.000Z")) ||
      new Date(input.postingDate + "T00:00:00.000Z").toISOString().slice(0, 10) !== input.postingDate)
    reject("POSTING_DATE_INVALID");

  const active = new Set(input.activeEmployeeIds);
  if (!active.size || active.size !== input.activeEmployeeIds.length ||
      input.activeEmployeeIds.some(id => !validId(id)) || input.items.length !== active.size ||
      new Set(input.items.map(i => i.id)).size !== input.items.length ||
      new Set(input.items.map(i => i.employeeId)).size !== input.items.length ||
      input.items.some(i => !validId(i.id) || !active.has(i.employeeId) || i.isPaid !== false))
    reject("EMPLOYEE_COVERAGE_OR_PAYMENT_INVALID");
  const items = input.items.map(normalizeItem).sort((a, b) => a.id - b.id);
  if (items.some(i => moneyToCents(i.baseSalary) <= 0n)) reject("SALARY_INVALID");
  const preview = buildPayrollPreview(items);
  if (preview.mismatchedItemIds.length) reject("TOTALS_MISMATCH");
  const digest = payrollSuperAdminApprovalDigest(companyId, run.id, items);
  if (receipt.digest !== digest) reject("APPROVED_DATA_CHANGED");

  const accountsById = new Map(accounts.map(a => [a.id, a]));
  if (accountsById.size !== accounts.length) reject("DUPLICATE_ACCOUNT_METADATA");
  const account = (id: number, expected: "expense" | "liability" | "asset") => {
    const a = accountsById.get(id);
    if (!validId(id) || !a || a.companyId !== companyId || a.type !== expected ||
        a.isActive !== true || a.isPostable !== true || a.isHeader !== false || a.status !== "ACTIVE")
      reject("ACCOUNT_MAPPING_INVALID");
  };
  account(mapping.salaryExpenseAccountId, "expense");
  account(mapping.allowanceExpenseAccountId, "expense");
  account(mapping.salaryPayableAccountId, "liability");
  account(mapping.taxPayableAccountId, "liability");
  account(mapping.bpjsPayableAccountId, "liability");

  const seenAdvances = new Set<number>();
  for (const r of reservations) {
    if (r.companyId !== companyId || r.runId !== run.id || !validId(r.advanceId) ||
        seenAdvances.has(r.advanceId)) reject("RESERVATION_SCOPE_OR_DUPLICATE");
    seenAdvances.add(r.advanceId);
    account(r.receivableAccountId, "asset");
    if (typeof r.amount !== "string" || typeof r.currentBalance !== "string" ||
        moneyToCents(r.amount) > moneyToCents(r.currentBalance)) reject("RESERVATION_EXCEEDS_BALANCE");
  }
  if (!kasbonReviewMatchesReservations(items.map(i => ({
    id: i.id, employee_id: i.employeeId, kasbon_deduction: i.kasbonDeduction,
  })), reservations)) reject("KASBON_RESERVATIONS_INVALID");

  const sum = (key: keyof Omit<PayrollPreviewItem, "id" | "employeeId">) =>
    items.reduce((total, i) => total + moneyToCents(i[key]), 0n);
  const salary = sum("baseSalary"), allowance = sum("allowance"), tax = sum("pph21");
  const bpjs = sum("bpjsJhtEmployee") + sum("bpjsKesEmployee");
  const kasbon = sum("kasbonDeduction"), net = sum("netSalary");
  const other = sum("otherDeductions");
  // Existing company-scoped payroll_coa_mappings supplies this optional account.
  // Never infer a balancing account from salary payable, tax, BPJS or kasbon.
  if (other > 0n) {
    if (!validId(mapping.otherDeductionPayableAccountId ?? 0)) reject("OTHER_DEDUCTION_MAPPING_REQUIRED");
    account(mapping.otherDeductionPayableAccountId!, "liability");
  }
  if (salary + allowance !== net + tax + bpjs + kasbon + other) reject("ACCRUAL_UNBALANCED");
  const kasbonByAccount = new Map<number, bigint>();
  for (const r of reservations) {
    kasbonByAccount.set(r.receivableAccountId,
      (kasbonByAccount.get(r.receivableAccountId) ?? 0n) + moneyToCents(r.amount as string));
  }
  return {
    companyId, runId: run.id, digest,
    source: "payroll" as const, sourceId: run.id, reference: `PAYROLL-${run.id}`,
    expectedStatus: "reviewed" as const, nextStatus: "approved" as const,
    approvalReceipt: { ...receipt }, approvedAt: run.approvedAt,
    mapping: { ...mapping },
    // Structurally compatible with AccrualJournalParams in the original service.
    params: {
      companyId, payrollRunId: run.id, period, date: input.postingDate,
      totalSalary: asLegacyAmount(salary), totalAllowance: asLegacyAmount(allowance),
      totalTax: asLegacyAmount(tax), totalBpjs: asLegacyAmount(bpjs),
      ...(other > 0n ? { totalOtherDeductions: asLegacyAmount(other) } : {}),
      kasbonByAccount: [...kasbonByAccount].sort(([a], [b]) => a - b)
        .map(([accountId, amount]) => ({ accountId, amount: asLegacyAmount(amount) })),
      totalSalaryPayable: asLegacyAmount(net),
    },
    debitTotal: centsToMoney(salary + allowance), creditTotal: centsToMoney(net + tax + bpjs + kasbon + other),
    readOnly: true as const, requiresAtomicPosting: true as const,
    accountingPosted: false as const, readyForPayment: false as const,
  };
}
