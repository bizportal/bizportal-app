import type { PoolClient } from "pg";
import { moneyToCents, payrollMonth } from "./payroll-kasbon-automatic";

/** Existing allocation/schedule ledger only. Never creates or repairs a
 * schedule, substitutes employee/loan identities or starts its own transaction.
 * Caller authenticates, locks the Payroll and advances, and owns SERIALIZABLE
 * commit/rollback. A matched allocation is NOT a second human approval.
 */
export type InstallmentHold = { id: string; advanceId: number; payrollItemId: unknown;
  employeeId: unknown; amount: unknown; currentBalance: unknown };
export type InstallmentAllocation = { id: number; itemId: number; advanceId: number;
  scheduleId: number | null; amount: string; beforeApproval: boolean; referenceCount: number };
export type InstallmentSchedule = { id: number; companyId: number; advanceId: number;
  number: number; dueDate: string; amount: string; status: string; repaymentId: number | null;
  paidDate: string | null; paidAmount: string | null; entryId: number | null; itemId: number | null;
  beforeApproval: boolean };
export type InstallmentContext = { companyId: number; runId: number; year: number; month: number;
  postingDate: string; approvedAt: string | Date; itemIds: readonly number[]; replay: boolean };
function fail(code: string): never { throw Error("PAYROLL_INSTALLMENT_" + code); }
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const amount = (v: unknown): bigint => {
  if (typeof v !== "string") return fail("AMOUNT_INVALID");
  return moneyToCents(v);
};
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v+"T00:00:00Z")) && new Date(v+"T00:00:00Z").toISOString().slice(0,10) === v;

export function matchLegacyInstallments(ctx: InstallmentContext, holds: readonly InstallmentHold[],
  allocations: readonly InstallmentAllocation[], schedules: readonly InstallmentSchedule[]) {
  if (!id(ctx.companyId) || !id(ctx.runId) || !date(ctx.postingDate)) fail("CONTEXT_INVALID");
  payrollMonth(ctx.year,ctx.month);
  const end = new Date(Date.UTC(ctx.year,ctx.month,0)).toISOString().slice(0,10);
  if (new Set(allocations.map(a=>a.id)).size !== allocations.length ||
      new Set(allocations.map(a=>a.advanceId)).size !== allocations.length ||
      new Set(schedules.map(s=>s.id)).size !== schedules.length ||
      new Set(holds.map(h=>h.advanceId)).size !== holds.length) fail("DUPLICATE_LINK");
  const links = new Map<string,InstallmentSchedule>();
  const seenSchedules = new Set<number>();
  for (const a of allocations) {
    const h = holds.find(h=>h.advanceId===a.advanceId && Number(h.payrollItemId)===a.itemId);
    const s = schedules.find(s=>s.id===a.scheduleId);
    if (!id(a.id) || !id(a.itemId) || !id(a.advanceId) || !id(a.scheduleId) ||
        !ctx.itemIds.includes(a.itemId) || !h || a.beforeApproval !== true || a.referenceCount !== 1 ||
        !s || s.companyId !== ctx.companyId || s.advanceId !== a.advanceId || !id(s.number) ||
        !date(s.dueDate) || s.dueDate > end ||
        amount(a.amount) <= 0n || amount(a.amount) !== amount(h.amount) || amount(s.amount) !== amount(a.amount))
      fail("LINK_NOT_EXACT");
    if (seenSchedules.has(s.id)) fail("DUPLICATE_LINK");
    seenSchedules.add(s.id);
    if (ctx.replay) {
      if (s.status !== "paid" || !id(s.repaymentId) || !id(s.entryId) || s.itemId !== a.itemId ||
          !date(s.paidDate) || amount(s.paidAmount) !== amount(a.amount)) fail("PAID_EVIDENCE_INVALID");
    } else {
      if (!["pending","overdue"].includes(s.status) || s.beforeApproval !== true ||
          s.dueDate > ctx.postingDate || s.repaymentId !== null || s.entryId !== null ||
          s.itemId !== null || s.paidDate !== null || (s.paidAmount !== null && amount(s.paidAmount)!==0n))
        fail("SCHEDULE_NOT_CLEAN_DUE");
      const outstanding = schedules.filter(x=>x.advanceId===a.advanceId && ["pending","overdue"].includes(x.status))
        .sort((a,b)=>a.number-b.number || a.id-b.id);
      if (!outstanding.length || outstanding[0]!.id !== s.id ||
          new Set(outstanding.map(x=>x.number)).size !== outstanding.length ||
          outstanding.some(x=>x.companyId!==ctx.companyId || !id(x.number) || !date(x.dueDate) || amount(x.amount)<=0n ||
            x.repaymentId!==null || x.entryId!==null || x.itemId!==null || x.paidDate!==null ||
            (x.paidAmount!==null && amount(x.paidAmount)!==0n)) ||
          outstanding.reduce((n,x)=>n+amount(x.amount),0n)!==amount(h.currentBalance))
        fail("SCHEDULE_BALANCE_OR_ORDER_MISMATCH");
      // Full installment only. No partial amount may be mislabeled fully paid.
      if (amount(h.amount)>amount(h.currentBalance)) fail("SCHEDULE_BALANCE_OR_ORDER_MISMATCH");
    }
    links.set(h.id,{...s});
  }
  for (const h of holds) {
    const relevant=schedules.filter(s=>s.advanceId===h.advanceId);
    if (ctx.replay) {
      if (relevant.some(s=>s.itemId===Number(h.payrollItemId) && !seenSchedules.has(s.id)))
        fail("PAID_LINK_MISSING");
    } else if (relevant.some(s=>["pending","overdue"].includes(s.status)) && !links.has(h.id)) {
      fail("EXPLICIT_ALLOCATION_REQUIRED");
    }
  }
  return links;
}

export async function lockLegacyInstallments(client: PoolClient, ctx: InstallmentContext, holds: readonly InstallmentHold[]) {
  const allocations=await client.query<InstallmentAllocation>(`SELECT a.id,a.payroll_item_id AS "itemId",
    a.cash_advance_id AS "advanceId",a.installment_schedule_id AS "scheduleId",a.amount::text,
    (a.created_at <= $3::timestamp) AS "beforeApproval",
    (SELECT count(*)::int FROM public.payroll_cash_advance_allocations peer
      WHERE peer.installment_schedule_id=a.installment_schedule_id) AS "referenceCount"
    FROM public.payroll_cash_advance_allocations a
    JOIN public.payroll_items i ON i.id=a.payroll_item_id
    JOIN public.payroll_runs r ON r.id=i.run_id
    WHERE r.id=$1 AND r.company_id=$2 ORDER BY a.cash_advance_id,a.id FOR SHARE OF a`,
    [ctx.runId,ctx.companyId,ctx.approvedAt]);
  const schedules=holds.length ? await client.query<InstallmentSchedule>(`SELECT id,company_id AS "companyId",
    advance_id AS "advanceId",installment_number AS number,due_date::text AS "dueDate",amount::text,status,
    repayment_id AS "repaymentId",paid_date::text AS "paidDate",paid_amount::text AS "paidAmount",
    accounting_entry_id AS "entryId",payroll_item_id AS "itemId",
    (created_at <= $3::timestamp AND updated_at <= $3::timestamp) AS "beforeApproval"
    FROM public.cash_advance_installment_schedules WHERE company_id=$1 AND advance_id=ANY($2::integer[])
    ORDER BY advance_id,installment_number,id FOR UPDATE`,
    [ctx.companyId,holds.map(h=>h.advanceId),ctx.approvedAt]) : {rows:[]};
  return matchLegacyInstallments(ctx,holds,allocations.rows,schedules.rows);
}

export async function confirmLegacyInstallment(client: PoolClient, ctx: InstallmentContext,
  hold: InstallmentHold, schedule: InstallmentSchedule, repaymentId: number, entryId: number) {
  if (!id(repaymentId)||!id(entryId)) fail("REPAYMENT_ID_INVALID");
  const updated=await client.query(`UPDATE public.cash_advance_installment_schedules SET status='paid',
    repayment_id=$1,paid_date=$2::date,paid_amount=$3::numeric,accounting_entry_id=$4,
    payroll_item_id=$5,updated_at=now()
    WHERE id=$6 AND company_id=$7 AND advance_id=$8 AND status=$9 AND amount=$3::numeric
      AND repayment_id IS NULL AND accounting_entry_id IS NULL AND payroll_item_id IS NULL
      AND paid_date IS NULL AND (paid_amount IS NULL OR paid_amount=0)
    RETURNING id`,[repaymentId,ctx.postingDate,hold.amount,entryId,Number(hold.payrollItemId),
      schedule.id,ctx.companyId,hold.advanceId,schedule.status]);
  if (updated.rowCount!==1) fail("CONFIRMATION_CHANGED");
  const read=await client.query(`SELECT s.id FROM public.cash_advance_installment_schedules s
    JOIN public.cash_advance_repayments r ON r.id=s.repayment_id
    WHERE s.id=$1 AND s.company_id=$2 AND s.advance_id=$3 AND s.status='paid'
      AND s.repayment_id=$4 AND s.accounting_entry_id=$5 AND s.payroll_item_id=$6
      AND s.paid_amount=$7::numeric AND s.paid_date=$8::date
      AND r.advance_id=s.advance_id AND r.entry_id=s.accounting_entry_id AND r.amount=s.paid_amount
      AND r.payment_method='payroll' AND r.date=s.paid_date AND r.posted_at IS NOT NULL`,
    [schedule.id,ctx.companyId,hold.advanceId,repaymentId,entryId,Number(hold.payrollItemId),hold.amount,ctx.postingDate]);
  if (read.rowCount!==1) fail("CONFIRMATION_NOT_VERIFIED");
}
