import type { Pool, PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { prepareReviewedPayrollAccrual, type PayrollHandoffInput, type PayrollHandoffAccount } from "./payroll-accounting-handoff";
import { buildPayrollPreview, type PayrollPreviewItem } from "./payroll-preview";
import { centsToMoney, moneyToCents, payrollMonth } from "./payroll-kasbon-automatic";
import { payrollSuperAdminApprovalDigest, readPayrollSuperAdminApprovalReceipt } from "./payroll-super-admin-approval-receipt";

/** DEV application service. HTTP adapter exists behind default-OFF gates;
 * it cannot post until trusted server bootstrap supplies the restricted binding.
 * `actor` must come from the existing signed-session verifier, never request JSON.
 * The caller must supply the dedicated settlement pool and the VERIFIED patched
 * native PayrollJournalService, not the legacy global-posting version.
 * No database credentials, global pool, bank transport or automatic DDL here.
 */
export interface PayrollAtomicRequest {
  companyId: number;
  runId: number;
  postingDate: string;
  expectedDigest: string;
  actor: { id: string; email: string; role: string };
}
type Plan = ReturnType<typeof prepareReviewedPayrollAccrual>;
export interface TransactionBoundPayrollWriter {
  readonly transactionalAccrualVersion: "payroll-accrual-atomic-v1";
  postAccrualJournal(mapping: Plan["mapping"], params: Plan["params"], client: NodePgDatabase): Promise<{ entryId: number }>;
}
type RunRow = {
  id: number; company_id: number; year: number; month: number; status: string;
  posting_status: string; approved_at: Date | string | null; notes: string | null;
  accounting_entry_id: number | null; payment_entry_id: number | null;
};
type Item = PayrollPreviewItem & { isPaid: boolean };
type Hold = PayrollHandoffInput["reservations"][number] & { id: string; period: string; confirmedAt: string | Date | null; cancelledAt: unknown };
type Advance = {
  id: number; company_id: number; employee_id: number; type: string; currency: string | null;
  amount: string; paid_amount: string; settled_amount: string; remaining_amount: string;
  receivable_account_id: number | null; status: string; lifecycle_status: string;
  approved_at: Date | string | null; approved_by: string | null; disbursed_at: Date | string | null;
  disbursed_by: string | null; accounting_entry_id: number | null; posting_status: string;
  voided_at: Date | string | null;
};
function fail(code: string): never { throw Error("PAYROLL_ATOMIC_" + code); }
function id(value: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= 2147483647; }
function errorCode(error: unknown): string | null {
  let value = error;
  for (let n = 0; n < 4 && value && typeof value === "object"; n++) {
    const e = value as { code?: unknown; cause?: unknown };
    if (typeof e.code === "string") return e.code;
    value = e.cause;
  }
  return null;
}
function repaymentKey(companyId: number, runId: number, hold: Hold): string {
  if (!/^[1-9][0-9]*$/.test(hold.id)) fail("RESERVATION_ID_INVALID");
  return `PAYROLL-C${companyId}-R${runId}-AUTO-${hold.id}`;
}
function cleanItem(i: Item): PayrollPreviewItem {
  return { id: i.id, employeeId: i.employeeId, baseSalary: i.baseSalary, allowance: i.allowance,
    grossSalary: i.grossSalary, bpjsJhtEmployee: i.bpjsJhtEmployee, bpjsKesEmployee: i.bpjsKesEmployee,
    pph21: i.pph21, otherDeductions: i.otherDeductions, kasbonDeduction: i.kasbonDeduction,
    totalDeductions: i.totalDeductions, netSalary: i.netSalary };
}
function expectedLines(items: readonly Item[], mapping: Plan["mapping"], holds: readonly Hold[]) {
  const totals = new Map<number, { debit: bigint; credit: bigint }>();
  const add = (accountId: number, debit: bigint, credit: bigint) => {
    if (!id(accountId)) fail("ACCOUNT_ID_INVALID");
    if (debit === 0n && credit === 0n) return;
    const prior = totals.get(accountId) ?? { debit: 0n, credit: 0n };
    totals.set(accountId, { debit: prior.debit + debit, credit: prior.credit + credit });
  };
  for (const i of items) {
    if (moneyToCents(i.otherDeductions) !== 0n) fail("OTHER_DEDUCTION_MAPPING_REQUIRED");
    add(mapping.salaryExpenseAccountId, moneyToCents(i.baseSalary), 0n);
    add(mapping.allowanceExpenseAccountId, moneyToCents(i.allowance), 0n);
    add(mapping.salaryPayableAccountId, 0n, moneyToCents(i.netSalary));
    add(mapping.taxPayableAccountId, 0n, moneyToCents(i.pph21));
    add(mapping.bpjsPayableAccountId, 0n, moneyToCents(i.bpjsJhtEmployee) + moneyToCents(i.bpjsKesEmployee));
  }
  for (const h of holds) add(h.receivableAccountId, 0n, moneyToCents(h.amount as string));
  return [...totals].sort(([a], [b]) => a - b).map(([accountId, t]) =>
    `${accountId}:${centsToMoney(t.debit)}:${centsToMoney(t.credit)}`);
}
async function verifyPersistedJournal(client: PoolClient, companyId: number, runId: number,
  entryId: number, items: readonly Item[], mapping: Plan["mapping"], holds: readonly Hold[]) {
  if (!id(entryId)) fail("JOURNAL_ID_INVALID");
  const preview = buildPayrollPreview(items.map(cleanItem));
  if (preview.mismatchedItemIds.length) fail("ITEM_TOTALS_CHANGED");
  const journal = await client.query<{ company_id: number; source: string; source_id: number; ref: string;
    status: string; total_debit: string; total_credit: string; voided_at: unknown; void_entry_id: number | null }>(
    `SELECT company_id,source,source_id,ref,status,total_debit::text,total_credit::text,voided_at,void_entry_id
     FROM public.accounting_entries WHERE id=$1 AND company_id=$2 FOR SHARE`, [entryId, companyId]);
  const j = journal.rows[0];
  if (journal.rows.length !== 1 || !j || j.company_id !== companyId || j.source !== "payroll" ||
      j.source_id !== runId || j.ref !== `PAYROLL-${runId}` || j.status !== "posted" ||
      j.voided_at != null || j.void_entry_id != null ||
      moneyToCents(j.total_debit) !== moneyToCents(preview.gross) ||
      moneyToCents(j.total_credit) !== moneyToCents(preview.gross)) fail("JOURNAL_NOT_VERIFIED");
  const lines = await client.query<{ account_id: number; debit: string; credit: string }>(
    `SELECT account_id,debit::text,credit::text FROM public.accounting_entry_lines WHERE entry_id=$1 ORDER BY id FOR SHARE`, [entryId]);
  const grouped = new Map<number, { debit: bigint; credit: bigint }>();
  for (const line of lines.rows) {
    const d = moneyToCents(line.debit), c = moneyToCents(line.credit);
    if (!id(line.account_id) || (d === 0n && c === 0n) || (d > 0n && c > 0n)) fail("JOURNAL_LINE_INVALID");
    const old = grouped.get(line.account_id) ?? { debit: 0n, credit: 0n };
    grouped.set(line.account_id, { debit: old.debit + d, credit: old.credit + c });
  }
  const observed = [...grouped].sort(([a], [b]) => a - b).map(([key, value]) =>
    `${key}:${centsToMoney(value.debit)}:${centsToMoney(value.credit)}`);
  if (JSON.stringify(observed) !== JSON.stringify(expectedLines(items, mapping, holds))) fail("JOURNAL_LINES_CHANGED");
}
async function execute(client: PoolClient, writer: TransactionBoundPayrollWriter, request: PayrollAtomicRequest) {
  const { companyId, runId } = request;
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '20s'");
  const identity = await client.query<{ name: string; login: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT current_user AS name, session_user AS login,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
  const principal = identity.rows[0];
  if (!principal || principal.name !== "bizportal_payroll_settlement_dev" || principal.login !== principal.name ||
      principal.rolsuper || principal.rolbypassrls) fail("DEDICATED_SETTLEMENT_ROLE_REQUIRED");
  await client.query("SELECT set_config('app.payroll_company_id',$1,true)", [String(companyId)]);
  await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [companyId, runId]);
  const runs = await client.query<RunRow>(`SELECT id,company_id,year,month,status,posting_status,approved_at::text AS approved_at,notes,
    accounting_entry_id,payment_entry_id FROM public.payroll_runs WHERE id=$1 AND company_id=$2 FOR UPDATE`, [runId, companyId]);
  const run = runs.rows[0];
  if (runs.rows.length !== 1 || !run) fail("RUN_NOT_FOUND_IN_COMPANY");
  const receipt = readPayrollSuperAdminApprovalReceipt(run.notes, run.approved_at, run.status);
  if (!receipt || receipt.actorId !== request.actor.id || receipt.actorEmail !== request.actor.email.trim().toLowerCase() ||
      receipt.digest !== request.expectedDigest) fail("APPROVAL_RECEIPT_MISMATCH");
  if (run.payment_entry_id != null) fail("PAYMENT_ALREADY_LINKED");
  const replay = run.status === "approved" && run.posting_status === "posted" && id(run.accounting_entry_id ?? 0);
  if (!replay && (run.status !== "reviewed" || run.posting_status !== "pending" || run.accounting_entry_id != null))
    fail("RUN_STATE_NOT_POSTABLE");
  const results = await client.query<Item>(`SELECT id,employee_id AS "employeeId",base_salary::text AS "baseSalary",
    allowance::text, gross_salary::text AS "grossSalary",bpjs_jht_employee::text AS "bpjsJhtEmployee",
    bpjs_kes_employee::text AS "bpjsKesEmployee",pph21::text,other_deductions::text AS "otherDeductions",
    kasbon_deduction::text AS "kasbonDeduction",total_deductions::text AS "totalDeductions",
    net_salary::text AS "netSalary",is_paid AS "isPaid"
    FROM public.payroll_items WHERE run_id=$1 ORDER BY id FOR UPDATE`, [runId]);
  const items = results.rows;
  if (!items.length || items.some(i => i.isPaid !== false) ||
      payrollSuperAdminApprovalDigest(companyId, runId, items.map(cleanItem)) !== request.expectedDigest)
    fail("APPROVED_ITEMS_CHANGED");
  const mappingRows = await client.query<Plan["mapping"]>(`SELECT salary_expense_account_id AS "salaryExpenseAccountId",
    allowance_expense_account_id AS "allowanceExpenseAccountId",salary_payable_account_id AS "salaryPayableAccountId",
    tax_payable_account_id AS "taxPayableAccountId",bpjs_payable_account_id AS "bpjsPayableAccountId"
    FROM public.accounting_settings WHERE company_id=$1 FOR SHARE`, [companyId]);
  const mapping = mappingRows.rows[0];
  if (mappingRows.rows.length !== 1 || !mapping || Object.values(mapping).some(v => !id(v))) fail("MAPPING_NOT_UNIQUE_OR_COMPLETE");
  const legacyAllocations = await client.query(`SELECT a.id FROM public.payroll_cash_advance_allocations a
    JOIN public.payroll_items i ON i.id=a.payroll_item_id WHERE i.run_id=$1 LIMIT 1`, [runId]);
  if (legacyAllocations.rows.length) fail("LEGACY_ALLOCATIONS_REQUIRE_RECONCILIATION");
  const holdResult = await client.query<Hold>(`SELECT id::text,company_id AS "companyId",run_id AS "runId",
    employee_id AS "employeeId",payroll_item_id AS "payrollItemId",advance_id AS "advanceId",
    period::text,amount::text,balance_at_preparation::text AS "heldBalance",state,
    confirmed_at AS "confirmedAt",cancelled_at AS "cancelledAt"
    FROM public.payroll_kasbon_auto_reservations WHERE run_id=$1 AND company_id=$2 ORDER BY advance_id,id FOR UPDATE`, [runId, companyId]);
  const holds = holdResult.rows;
  const advanceIds = holds.map(h => h.advanceId);
  if (new Set(advanceIds).size !== advanceIds.length) fail("DUPLICATE_ADVANCE");
  const advanceRows = await client.query<Advance>(`SELECT id,company_id,employee_id,type,currency,amount::text,
    paid_amount::text,settled_amount::text,remaining_amount::text,receivable_account_id,status,lifecycle_status,
    approved_at,approved_by,disbursed_at,disbursed_by,accounting_entry_id,posting_status,voided_at
    FROM public.cash_advances WHERE company_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR UPDATE`, [companyId, advanceIds]);
  if (advanceRows.rows.length !== advanceIds.length) fail("ADVANCE_MISSING_OR_FOREIGN");
  if (!replay && advanceIds.length) {
    const legacySchedules = await client.query(`SELECT id FROM public.cash_advance_installment_schedules
      WHERE advance_id=ANY($1::integer[]) AND status IN ('pending','overdue') LIMIT 1`, [advanceIds]);
    if (legacySchedules.rows.length) fail("LEGACY_INSTALLMENT_SCHEDULE_REQUIRES_RECONCILIATION");
  }
  const byId = new Map(advanceRows.rows.map(a => [a.id, a]));
  const period = payrollMonth(run.year, run.month);
  for (const h of holds) {
    const a = byId.get(h.advanceId)!;
    if (a.employee_id !== h.employeeId || a.type !== "kasbon" || (a.currency ?? "IDR") !== "IDR" ||
        h.period !== period || h.cancelledAt != null || !id(a.receivable_account_id ?? 0)) fail("RESERVATION_IDENTITY_INVALID");
    Object.assign(h, { receivableAccountId: a.receivable_account_id, currentBalance: a.remaining_amount,
      advanceStatus: a.status, advanceLifecycle: a.lifecycle_status, advanceApprovedAt: a.approved_at,
      advanceApprovedBy: a.approved_by, advanceDisbursedAt: a.disbursed_at, advanceDisbursedBy: a.disbursed_by,
      advanceAccountingEntryId: a.accounting_entry_id, advancePostingStatus: a.posting_status, advanceVoidedAt: a.voided_at });
  }
  const itemById = new Map(items.map(i => [i.id, i]));
  const deductionByItem = new Map<number, bigint>();
  for (const h of holds) {
    const matching = itemById.get(Number(h.payrollItemId));
    const amount = moneyToCents(h.amount as string);
    if (!matching || matching.employeeId !== h.employeeId || amount <= 0n ||
        amount > moneyToCents(h.heldBalance as string)) fail("RESERVATION_ITEM_AMOUNT_INVALID");
    deductionByItem.set(matching.id, (deductionByItem.get(matching.id) ?? 0n) + amount);
  }
  if (items.some(i => moneyToCents(i.kasbonDeduction) !== (deductionByItem.get(i.id) ?? 0n)))
    fail("RESERVATION_ITEM_TOTALS_CHANGED");
  const replayLedger = async (entryId: number) => {
    const repayments = await client.query<{ advance_id: number; amount: string; idempotency_key: string;
      entry_id: number; payment_method: string; posted_at: Date | null }>(`SELECT advance_id,amount::text,idempotency_key,
      entry_id,payment_method,posted_at FROM public.cash_advance_repayments WHERE entry_id=$1 FOR SHARE`, [entryId]);
    if (repayments.rows.length !== holds.length) fail("REPAYMENT_LEDGER_COUNT_CHANGED");
    for (const h of holds) {
      const ledger = repayments.rows.filter(r => r.idempotency_key === repaymentKey(companyId, runId, h));
      if (h.state !== "confirmed" || !h.confirmedAt || ledger.length !== 1 || ledger[0]!.advance_id !== h.advanceId ||
          ledger[0]!.entry_id !== entryId || ledger[0]!.payment_method !== "payroll" || !ledger[0]!.posted_at ||
          moneyToCents(ledger[0]!.amount) !== moneyToCents(h.amount as string)) fail("REPAYMENT_LEDGER_NOT_VERIFIED");
    }
  };
  if (replay) {
    await verifyPersistedJournal(client, companyId, runId, run.accounting_entry_id!, items, mapping, holds);
    await replayLedger(run.accounting_entry_id!);
    return { entryId: run.accounting_entry_id!, reused: true, salaryPaid: false as const };
  }
  const orphan = await client.query(`SELECT id FROM public.accounting_entries WHERE company_id=$1 AND source='payroll'
    AND source_id=$2 LIMIT 1`, [companyId, runId]);
  if (orphan.rows.length) fail("UNLINKED_JOURNAL_REQUIRES_RECOVERY");
  const active = await client.query<{ id: number }>(`SELECT id FROM public.employees WHERE company_id=$1
    AND status='active' AND deleted_at IS NULL ORDER BY id FOR SHARE`, [companyId]);
  const accountIds = [...new Set([...Object.values(mapping), ...holds.map(h => h.receivableAccountId)])];
  const accounts = await client.query<PayrollHandoffAccount>(`SELECT id,company_id AS "companyId",type::text,
    is_active AS "isActive",is_postable AS "isPostable",is_header AS "isHeader",status
    FROM public.chart_of_accounts WHERE company_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR SHARE`, [companyId, accountIds]);
  const plan = prepareReviewedPayrollAccrual({ companyId, postingDate: request.postingDate,
    run: { id: runId, companyId, year: run.year, month: run.month, status: run.status, postingStatus: run.posting_status,
      approvedAt: run.approved_at, notes: run.notes, accountingEntryId: run.accounting_entry_id, paymentEntryId: run.payment_entry_id },
    items, activeEmployeeIds: active.rows.map(e => e.id), mapping, accounts: accounts.rows, reservations: holds });
  const date = new Date(request.postingDate + "T00:00:00Z");
  const periods = await client.query<{ is_closed: boolean; override_allowed: boolean }>(`SELECT is_closed,override_allowed
    FROM public.financial_periods WHERE company_id=$1 AND year=$2 AND month=$3 FOR SHARE`,
    [companyId, date.getUTCFullYear(), date.getUTCMonth() + 1]);
  if (periods.rows.length !== 1) fail("POSTING_PERIOD_NOT_CONFIGURED");
  if (periods.rows[0]!.is_closed && !periods.rows[0]!.override_allowed) fail("POSTING_PERIOD_CLOSED");
  for (const h of holds) {
    const a = byId.get(h.advanceId)!;
    if (moneyToCents(a.amount) !== moneyToCents(a.settled_amount) + moneyToCents(a.remaining_amount) ||
        moneyToCents(a.paid_amount) > moneyToCents(a.amount)) fail("ADVANCE_TOTALS_INCONSISTENT");
    const existing = await client.query(`SELECT id FROM public.cash_advance_repayments WHERE idempotency_key=$1`,
      [repaymentKey(companyId, runId, h)]);
    if (existing.rows.length) fail("REPAYMENT_ALREADY_EXISTS_WITHOUT_RUN_LINK");
  }
  // This is the existing, transaction-aware native writer; no financial line
  // INSERT or replacement journal engine exists in this application module.
  const posted = await writer.postAccrualJournal(plan.mapping, plan.params, drizzle(client));
  await verifyPersistedJournal(client, companyId, runId, posted.entryId, items, mapping, holds);
  for (const h of holds) {
    const amount = h.amount as string;
    const update = await client.query(`UPDATE public.cash_advances SET paid_amount=paid_amount+$1::numeric,
      settled_amount=settled_amount+$1::numeric,remaining_amount=remaining_amount-$1::numeric,
      status=CASE WHEN remaining_amount-$1::numeric<=0.005 THEN 'repaid' ELSE 'partial' END,
      lifecycle_status=CASE WHEN remaining_amount-$1::numeric<=0.005 THEN 'settled' ELSE 'partially_settled' END,
      repayment_journal_id=$2,repaid_at=CASE WHEN remaining_amount-$1::numeric<=0.005 THEN now() ELSE repaid_at END,
      updated_at=now() WHERE id=$3 AND company_id=$4 AND employee_id=$5 AND type='kasbon'
      AND remaining_amount=$6::numeric AND remaining_amount>=$1::numeric RETURNING id`,
      [amount, posted.entryId, h.advanceId, companyId, h.employeeId, h.heldBalance]);
    if (update.rowCount !== 1) fail("ADVANCE_BALANCE_CHANGED");
    const ledger = await client.query(`INSERT INTO public.cash_advance_repayments
      (advance_id,amount,payment_method,date,notes,entry_id,idempotency_key,posted_at,created_by,payment_reference)
      VALUES($1,$2::numeric,'payroll',$3::date,$4,$5,$6,now(),$7,$8) RETURNING id`,
      [h.advanceId, amount, request.postingDate, `Potongan Payroll ${period.slice(0, 7)}`, posted.entryId,
        repaymentKey(companyId, runId, h), request.actor.id, `PAYROLL-${runId}`]);
    if (ledger.rowCount !== 1) fail("REPAYMENT_NOT_RECORDED");
    const confirm = await client.query(`UPDATE public.payroll_kasbon_auto_reservations SET state='confirmed',confirmed_at=now()
      WHERE id=$1 AND company_id=$2 AND run_id=$3 AND state='prepared' AND cancelled_at IS NULL RETURNING id`,
      [h.id, companyId, runId]);
    if (confirm.rowCount !== 1) fail("RESERVATION_CONFIRMATION_FAILED");
  }
  const linked = await client.query(`UPDATE public.payroll_runs SET status='approved',posting_status='posted',
    accounting_entry_id=$1,posted_at=now(),posting_error=NULL,posting_claimed_at=NULL WHERE id=$2 AND company_id=$3 AND status='reviewed' AND posting_status='pending'
    AND accounting_entry_id IS NULL AND payment_entry_id IS NULL
    AND approved_at IS NOT DISTINCT FROM $4 AND notes IS NOT DISTINCT FROM $5
    RETURNING id`, [posted.entryId, runId, companyId, run.approved_at, run.notes]);
  if (linked.rowCount !== 1) fail("PAYROLL_LINK_CHANGED");
  return { entryId: posted.entryId, reused: false, salaryPaid: false as const };
}

/** Complete transaction owned here. Serialisation/deadlock retries occur only
 * after ROLLBACK; network/ambiguous COMMIT errors are never auto-retried.
 * The API caller still must validate its signed OTP session. Default closed.
 */
export async function postReviewedPayrollAccrualTransaction(
  pool: Pick<Pool, "connect">, writer: TransactionBoundPayrollWriter, request: PayrollAtomicRequest,
) {
  if (process.env.APP_ENV !== "development" || process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED !== "true")
    fail("DEV_POSTING_DISABLED");
  if (!id(request.companyId) || !id(request.runId) || !/^[0-9a-f]{64}$/.test(request.expectedDigest) ||
      request.actor?.role !== "super_admin" || !request.actor.id?.trim() ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(request.actor.email ?? "")) fail("TRUSTED_ACTOR_AND_SCOPE_REQUIRED");
  if (!writer || writer.transactionalAccrualVersion !== "payroll-accrual-atomic-v1" ||
      typeof writer.postAccrualJournal !== "function") fail("TRANSACTIONAL_WRITER_REQUIRED");
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await pool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await execute(client, writer, request);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch { discard = new Error("PAYROLL_ATOMIC_ROLLBACK_FAILED"); }
      if (!discard && attempt < 2 && ["40001", "40P01"].includes(errorCode(error) ?? "")) continue;
      throw error;
    } finally { client.release(discard); }
  }
  return fail("RETRY_LIMIT");
}
