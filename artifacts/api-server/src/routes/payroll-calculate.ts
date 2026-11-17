import type { Pool, PoolClient } from "pg";
import {
  calculateKasbonAutoDeduction, centsToMoney, moneyToCents, payrollMonth,
  type KasbonAdvance, type KasbonPlan, type KasbonPrepared,
} from "./payroll-kasbon-automatic";
import { buildPayrollPreview, type PayrollPreviewItem } from "./payroll-preview";
import { PAYROLL_SUPER_ADMIN_APPROVAL_MARKER, payrollSuperAdminApprovalDigest } from "./payroll-super-admin-approval-receipt";
import { verifyKasbonReviewLedger } from "./payroll-kasbon-hr-review-guard";

const fail = (reason: string): never => { throw Error("PAYROLL_CALCULATE_" + reason); };
const int = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) return fail("INVALID_ID");
  return n;
};
const cents = (value: unknown): bigint => moneyToCents(String(value));
type Item = {
  id: number; employee_id: number; is_paid: boolean; employee_company: number | null;
  employee_status: string | null; employee_deleted: Date | null; cash_advance_id: number | null;
  base_salary: string; allowance: string; gross_salary: string; bpjs_jht_employee: string;
  bpjs_kes_employee: string; pph21: string; other_deductions: string;
  kasbon_deduction: string; total_deductions: string; net_salary: string;
};
type Hold = {
  id: number; companyId: number; runId: number; payrollItemId: number; employeeId: number;
  advanceId: number; period: string; amount: string; balanceAtPreparation: string; state: string;
};
type AdvanceRow = KasbonAdvance;
type PlanRow = KasbonPlan & { employeeId: number };

const itemSQL = `SELECT pi.id,pi.employee_id,pi.is_paid,pi.cash_advance_id,
 pi.base_salary::text,pi.allowance::text,pi.gross_salary::text,
 pi.bpjs_jht_employee::text,pi.bpjs_kes_employee::text,pi.pph21::text,
 pi.other_deductions::text,pi.kasbon_deduction::text,pi.total_deductions::text,pi.net_salary::text,
 e.company_id AS employee_company,e.status AS employee_status,e.deleted_at AS employee_deleted
 FROM public.payroll_items pi LEFT JOIN public.employees e ON e.id=pi.employee_id
 WHERE pi.run_id=$1 ORDER BY pi.id FOR UPDATE OF pi`;

/**
 * One signed-request transaction, no payroll status transition, financial
 * posting or loan settlement. Calculate materializes prepared holds only.
 * Approval later moves a clean Draft directly to reviewed.
 */
export async function applyPayrollCalculation(client: PoolClient, companyId: number, runId: number) {
  const runResult = await client.query(`SELECT id,company_id,year,month,status,posting_status,
    approved_at,accounting_entry_id,payment_entry_id,notes FROM public.payroll_runs
    WHERE id=$1 AND company_id=$2 FOR UPDATE`, [runId, companyId]);
  const run = runResult.rows[0];
  if (runResult.rowCount !== 1 || !run) fail("RUN_NOT_FOUND");
  if (run.status !== "draft" || run.posting_status !== "pending" ||
      run.approved_at != null || run.accounting_entry_id != null || run.payment_entry_id != null ||
      String(run.notes ?? "").includes(PAYROLL_SUPER_ADMIN_APPROVAL_MARKER))
    fail("RUN_NOT_CLEAN_DRAFT");
  const period = payrollMonth(Number(run.year), Number(run.month));
  const employees = await client.query(`SELECT id FROM public.employees
    WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY id`, [companyId]);
  const active = employees.rows.map(row => int(row.id));
  if (active.length < 1 || active.length > 999 || new Set(active).size !== active.length)
    fail("ROSTER_NOT_READY");
  const original = await client.query<Item>(itemSQL, [runId]);
  const items = original.rows;
  if (items.length !== active.length || new Set(items.map(r => Number(r.employee_id))).size !== items.length ||
      items.some(r => !active.includes(Number(r.employee_id)) || Number(r.employee_company) !== companyId ||
        r.employee_status !== "active" || r.employee_deleted != null ||
        r.is_paid !== false || r.cash_advance_id != null))
    fail("ROSTER_NOT_READY");

  const source = await client.query(`SELECT id,company_id AS "companyId",employee_id AS "employeeId",
      type,status,lifecycle_status AS "lifecycleStatus",currency,amount::text,
      paid_amount::text AS "paidAmount",settled_amount::text AS "settledAmount",
      remaining_amount::text AS "remainingAmount",approved_at AS "approvedAt",
      approved_by AS "approvedBy",disbursed_at AS "disbursedAt",
      disbursed_by AS "disbursedBy",accounting_entry_id AS "accountingEntryId",
      posting_status AS "postingStatus",voided_at AS "voidedAt"
    FROM public.cash_advances WHERE company_id=$1 AND employee_id=ANY($2::integer[])
      AND type='kasbon' ORDER BY id`, [companyId,active]);
  const advances = source.rows as AdvanceRow[];
  const ids = advances.map(a => int(a.id));
  if (new Set(ids).size !== ids.length) fail("DUPLICATE_ADVANCE");

  // A legacy ledger must not be implicitly replaced by an auto reservation.
  // Require explicit reconciliation using the already-existing ledger path.
  const allocations = await client.query(`SELECT a.id FROM public.payroll_cash_advance_allocations a
    JOIN public.payroll_items i ON i.id=a.payroll_item_id
    WHERE i.run_id=$1 LIMIT 1`, [runId]);
  if (allocations.rowCount) fail("LEGACY_ALLOCATION_REQUIRES_RECONCILIATION");
  if (ids.length) {
    const pending = await client.query(`SELECT id FROM public.cash_advance_installment_schedules
      WHERE company_id=$1 AND advance_id=ANY($2::integer[])
        AND status IN ('pending','overdue') LIMIT 1`, [companyId, ids]);
    if (pending.rowCount) fail("LEGACY_SCHEDULE_REQUIRES_RECONCILIATION");
  }

  const plansResult = await client.query(`SELECT employee_id AS "employeeId",advance_id AS "advanceId",
    choice,installment_amount::text AS "installmentAmount",
    to_char(first_period,'YYYY-MM-DD') AS "firstPeriod"
    FROM public.payroll_kasbon_auto_plans
    WHERE company_id=$1 AND employee_id=ANY($2::integer[]) ORDER BY advance_id`, [companyId, active]);
  const plans = plansResult.rows as PlanRow[];
  const holdsResult = await client.query(`SELECT id,company_id AS "companyId",run_id AS "runId",
    employee_id AS "employeeId",payroll_item_id AS "payrollItemId",
    advance_id AS "advanceId",period::text,amount::text,
    balance_at_preparation::text AS "balanceAtPreparation",state
    FROM public.payroll_kasbon_auto_reservations
    WHERE company_id=$1 AND (run_id=$2 OR advance_id=ANY($3::integer[]))
    ORDER BY advance_id,id`, [companyId,runId,ids]);
  const holds = holdsResult.rows as Hold[];
  if (holds.some(h => h.runId === runId && (!ids.includes(Number(h.advanceId)) ||
    !active.includes(Number(h.employeeId)) || h.period !== period ||
    h.state !== "prepared")))
    fail("OLD_RESERVATION_MISMATCH");

  const toInsert: Array<{itemId:number;employeeId:number;advanceId:number;amount:string;balance:string}> = [];
  const plannedAmounts = new Map<number,bigint>();
  for (const item of items) {
    const employeeId = int(item.employee_id);
    const employeeAdvances = advances.filter(a => Number(a.employeeId) === employeeId);
    const employeePlans = plans.filter(p => Number(p.employeeId) === employeeId);
    const employeeHolds = holds.filter(h => Number(h.employeeId) === employeeId);
    const prepared: KasbonPrepared[] = employeeHolds.map(h => ({
      advanceId:int(h.advanceId),period:h.period,amount:h.amount,
      state:h.state as KasbonPrepared["state"],balanceAtPreparation:h.balanceAtPreparation,
    }));
    const projected = calculateKasbonAutoDeduction(employeeAdvances,employeePlans,prepared,
      companyId,employeeId,Number(run.year),Number(run.month));
    if (projected.total === null) fail("PLAN_OR_ADVANCE_NOT_READY");
    const planned = new Set<number>();
    for (const suggestion of projected.rows) {
      if (!suggestion.proposed) continue;
      const amount = cents(suggestion.proposed);
      if (amount === 0n) continue;
      const advanceId = int(suggestion.advanceId);
      planned.add(advanceId);
      const prior = employeeHolds.filter(h => h.advanceId === advanceId && h.period === period &&
        h.state === "prepared");
      if (prior.length > 1 || prior.some(h => h.runId !== runId ||
        h.payrollItemId !== item.id || cents(h.amount) !== amount ||
        cents(h.balanceAtPreparation) !== cents(suggestion.balance)))
        fail("OLD_RESERVATION_MISMATCH");
      if (!prior.length) toInsert.push({itemId:item.id,employeeId,advanceId,
        amount:suggestion.proposed,balance:suggestion.balance});
    }
    if (employeeHolds.some(h => h.runId === runId && h.state === "prepared" &&
      !planned.has(h.advanceId))) fail("OLD_RESERVATION_MISMATCH");
    const projectedCents = cents(projected.total);
    if (projectedCents > 0n && cents(item.kasbon_deduction) > 0n &&
      !employeeHolds.some(h => h.runId === runId && h.state === "prepared"))
      fail("UNBACKED_KASBON_DEDUCTION");
    if (projectedCents === 0n && cents(item.kasbon_deduction) > 0n)
      fail("UNBACKED_KASBON_DEDUCTION");
    plannedAmounts.set(item.id,projectedCents);
  }

  let changed = 0;
  for (const item of items) {
    const expected = plannedAmounts.get(item.id)!;
    const gross = cents(item.base_salary) + cents(item.allowance);
    if (cents(item.base_salary) <= 0n || gross <= 0n || cents(item.gross_salary) !== gross)
      fail("GROSS_INCONSISTENT");
    const deductions = cents(item.bpjs_jht_employee) + cents(item.bpjs_kes_employee) +
      cents(item.pph21) + cents(item.other_deductions) + expected;
    if (deductions > gross) fail("DEDUCTIONS_EXCEED_GROSS");
    const net = gross - deductions;
    if (cents(item.kasbon_deduction) === expected &&
      cents(item.total_deductions) === deductions && cents(item.net_salary) === net) continue;
    const updated = await client.query(`UPDATE public.payroll_items
      SET kasbon_deduction=$1::numeric,total_deductions=$2::numeric,net_salary=$3::numeric
      WHERE id=$4 AND run_id=$5 AND kasbon_deduction=$6::numeric
      RETURNING id`, [centsToMoney(expected),centsToMoney(deductions),centsToMoney(net),
      item.id,runId,item.kasbon_deduction]);
    if (updated.rowCount !== 1) fail("ITEM_CHANGED");
    changed++;
  }
  for (const hold of toInsert) {
    const inserted = await client.query(`INSERT INTO public.payroll_kasbon_auto_reservations
      (company_id,run_id,employee_id,payroll_item_id,advance_id,period,amount,balance_at_preparation,state)
      VALUES($1,$2,$3,$4,$5,$6::date,$7::numeric,$8::numeric,'prepared') RETURNING id`,
      [companyId,runId,hold.employeeId,hold.itemId,hold.advanceId,period,hold.amount,hold.balance]);
    if (inserted.rowCount !== 1) fail("RESERVATION_NOT_CREATED");
  }

  const readback = await client.query<Item>(itemSQL,[runId]);
  if (readback.rowCount !== items.length) fail("READBACK_ROSTER_CHANGED");
  const previewItems: PayrollPreviewItem[] = readback.rows.map(row => ({
    id:int(row.id),employeeId:int(row.employee_id),
    baseSalary:row.base_salary,allowance:row.allowance,grossSalary:row.gross_salary,
    bpjsJhtEmployee:row.bpjs_jht_employee,bpjsKesEmployee:row.bpjs_kes_employee,
    pph21:row.pph21,otherDeductions:row.other_deductions,kasbonDeduction:row.kasbon_deduction,
    totalDeductions:row.total_deductions,netSalary:row.net_salary,
  }));
  const preview = buildPayrollPreview(previewItems);
  if (preview.mismatchedItemIds.length) fail("CALCULATED_TOTALS_MISMATCH");
  const verified = await verifyKasbonReviewLedger(
    (sql,args)=>client.query(sql,args),companyId,runId,readback.rows);
  if (!verified) fail("KASBON_LEDGER_MISMATCH");
  const draft = await client.query(`SELECT status,approved_at,accounting_entry_id,
    payment_entry_id FROM public.payroll_runs WHERE id=$1 AND company_id=$2`,[runId,companyId]);
  if (draft.rowCount !== 1 || draft.rows[0].status !== "draft" ||
      draft.rows[0].approved_at != null || draft.rows[0].accounting_entry_id != null ||
      draft.rows[0].payment_entry_id != null) fail("RUN_CHANGED");
  return {companyId,runId,status:"draft",period,itemCount:preview.itemCount,
    gross:preview.gross,deductions:preview.deductions,net:preview.net,
    digest:payrollSuperAdminApprovalDigest(companyId,runId,previewItems),
    preparedReservations:toInsert.length,updatedItems:changed,
    readyForSuperAdminApproval:true,approved:false,accountingPosted:false,salaryPaid:false};
}

/** Caller is signed+company-authorized. One transaction, one scoped writer.
 * An uncertain COMMIT is never blindly retried. No shared application pool.
 */
export async function calculateDevPayroll(pool: Pick<Pool,"connect">,companyId:number,runId:number) {
  if (process.env.APP_ENV !== "development" || process.env.PAYROLL_DEV_CALCULATE_ENABLED !== "true")
    fail("DEV_DISABLED");
  int(companyId); int(runId);
  for (let attempt=0; attempt<3; attempt++) {
    const client = await pool.connect();
    let transaction = false, rollbackSucceeded = false, discardConnection = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); transaction = true;
    await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
    const identity = await client.query(`SELECT current_user AS role,
      current_setting('app.payroll_company_id',true) AS company,
      has_column_privilege(current_user,'public.payroll_items','kasbon_deduction','UPDATE') AS can_write_kasbon,
      has_column_privilege(current_user,'public.payroll_items','net_salary','UPDATE') AS can_write_net,
      has_column_privilege(current_user,'public.payroll_items','total_deductions','UPDATE') AS can_write_deductions,
      (SELECT bool_and(has_column_privilege(current_user,'public.payroll_kasbon_auto_reservations',c,'INSERT'))
       FROM unnest(ARRAY['company_id','run_id','employee_id','payroll_item_id','advance_id',
        'period','amount','balance_at_preparation','state']) AS c) AS can_reserve`);
    if (identity.rowCount !== 1 || identity.rows[0].role !== "bizportal_payroll_dev" ||
        identity.rows[0].company !== String(companyId) ||
        identity.rows[0].can_write_kasbon !== true || identity.rows[0].can_write_net !== true ||
        identity.rows[0].can_write_deductions !== true || identity.rows[0].can_reserve !== true) fail("DEDICATED_ROLE_NOT_READY");
    await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)",[companyId,-runId]);
    const result = await applyPayrollCalculation(client,companyId,runId);
      await client.query("COMMIT"); transaction = false;
      return result;
    } catch(error) {
      if (transaction) {
        try { await client.query("ROLLBACK"); rollbackSucceeded = true; }
        catch { discardConnection = true; }
      }
      const sqlstate = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "") : "";
      // Retry only PostgreSQL's explicit aborted serializations/deadlocks
      // after a confirmed rollback. Other (including ambiguous COMMIT) errors
      // are not replayed; an unhealthy connection is discarded from the pool.
      if (rollbackSucceeded && ["40001","40P01"].includes(sqlstate) && attempt < 2)
        continue;
      throw error;
    } finally { client.release(discardConnection); }
  }
  return fail("RETRY_EXHAUSTED");
}
