import type { Pool, PoolClient } from "pg";

/** Uses the ALREADY EXISTING CST-DEV financial-period insert/audit contract.
 * Never creates a policy, period override, funding approval, journal or payment.
 * actor is trusted server-session context, not a request-body assertion.
 */
export type PayrollPeriodRegistration = {
  companyId: number; runId: number; requestId: string; note: string;
  actor: { id: string; email: string; role: string };
};
type Run = { id: number; company_id: number; month: number; year: number; status: string;
  posting_status: string; accounting_entry_id: number | null; payment_entry_id: number | null };
type Period = { id: number; company_id: number; month: number; year: number; is_closed: boolean;
  override_allowed: boolean; closed_at: unknown; closed_by: unknown; period_close_signature: unknown; close_reason: unknown };
type Audit = { id: string; company_id: number; run_id: number; action: string; period_id: number;
  request_id: string; actor_id: string; actor_email: string; note: string;
  bank_account_id: number | null; source_version: string | null; evidence_reference: string | null };
const enabled = () => process.env.APP_ENV === "development" &&
  process.env.PAYROLL_DEV_FINANCIAL_SETUP_ENABLED === "true";
function fail(code: string): never { throw Error("PAYROLL_PERIOD_" + code); }
function validId(value: number) { return Number.isInteger(value) && value > 0 && value <= 2147483647; }
function validate(input: PayrollPeriodRegistration) {
  if (!enabled()) fail("DEV_DISABLED");
  if (!input || !validId(input.companyId) || !validId(input.runId) ||
      typeof input.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId) ||
      typeof input.note !== "string" || input.note.trim().length < 10 || input.note.trim().length > 500 || /\u0000/.test(input.note))
    fail("REQUEST_INVALID");
  const pinnedId = process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV?.trim();
  const pinnedEmail = process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV?.trim().toLowerCase();
  if (!pinnedId || !pinnedEmail || input.actor?.role !== "super_admin" || input.actor.id !== pinnedId ||
      typeof input.actor.email !== "string" || input.actor.email.trim().toLowerCase() !== pinnedEmail)
    fail("VERIFIED_ACTOR_REQUIRED");
  return { ...input, requestId: input.requestId.toLowerCase(), note: input.note.trim(),
    actor: { ...input.actor, email: pinnedEmail } };
}
const periodFields = "id,company_id,month,year,is_closed,override_allowed,closed_at,closed_by,period_close_signature,close_reason";
const auditFields = "id::text,company_id,run_id,action,period_id,request_id::text,actor_id,actor_email,note,bank_account_id,source_version,evidence_reference";
function checkOpen(period: Period | undefined, run: Run): asserts period is Period {
  if (!period || !validId(period.id) || period.company_id !== run.company_id || period.month !== run.month || period.year !== run.year)
    fail("PERIOD_IDENTITY_INVALID");
  if (period.is_closed !== false || period.override_allowed !== false || period.closed_at != null ||
      period.closed_by != null || period.period_close_signature != null || period.close_reason != null)
    fail("CLOSED_OR_OVERRIDE_PERIOD");
}
function checkAudit(audit: Audit | undefined, input: PayrollPeriodRegistration, period: Period): asserts audit is Audit {
  if (!audit || !/^[1-9][0-9]*$/.test(audit.id) || audit.company_id !== input.companyId || audit.run_id !== input.runId ||
      audit.action !== "period_registered" || audit.period_id !== period.id || audit.request_id !== input.requestId ||
      audit.actor_id !== input.actor.id || audit.actor_email !== input.actor.email || audit.note !== input.note ||
      audit.bank_account_id !== null || audit.source_version !== null || audit.evidence_reference !== null)
    fail("AUDIT_MISSING_OR_CHANGED");
}
async function execute(client: PoolClient, input: PayrollPeriodRegistration) {
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='15s'");
  const identity = await client.query<{ actor: string; login: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
    "SELECT current_user AS actor,session_user AS login,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user");
  const r = identity.rows[0];
  if (identity.rows.length !== 1 || !r || r.actor !== "bizportal_payroll_dev" || r.login !== r.actor ||
      [r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb].some(v => v !== false)) fail("DEDICATED_IDENTITY_REQUIRED");
  await client.query(`SELECT set_config('app.payroll_company_id',$1,true),set_config('app.payroll_setup_run_id',$2,true),
    set_config('app.payroll_setup_request_id',$3,true),set_config('app.payroll_setup_actor_id',$4,true),
    set_config('app.payroll_setup_actor_email',$5,true),set_config('app.payroll_setup_note',$6,true)`,
    [String(input.companyId),String(input.runId),input.requestId,input.actor.id,input.actor.email,input.note]);
  const runs = await client.query<Run>(`SELECT id,company_id,month,year,status,posting_status,accounting_entry_id,payment_entry_id
    FROM public.payroll_runs WHERE id=$1 AND company_id=$2 FOR UPDATE`,[input.runId,input.companyId]);
  const run = runs.rows[0];
  if (runs.rows.length !== 1 || !run) fail("RUN_NOT_FOUND");
  if (!Number.isInteger(run.year) || run.year < 2000 || run.year > 2099 || !Number.isInteger(run.month) || run.month < 1 || run.month > 12)
    fail("RUN_PERIOD_INVALID");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('payroll-period-registration'),hashtext($1))",[`${input.companyId}:${run.year}:${run.month}`]);
  const locks = await client.query<{ status: string | null }>(`SELECT status FROM public.accounting_period_locks
    WHERE company_id=$1 AND year=$2 AND month=$3`,[input.companyId,run.year,run.month]);
  if (locks.rows.some(row => row.status !== "unlocked")) fail("ACCOUNTING_PERIOD_LOCKED");
  const periods = await client.query<Period>(`SELECT ${periodFields} FROM public.financial_periods
    WHERE company_id=$1 AND year=$2 AND month=$3`,[input.companyId,run.year,run.month]);
  if (periods.rows.length > 1) fail("PERIOD_NOT_UNIQUE");
  const prior = await client.query<Audit>(`SELECT ${auditFields} FROM public.payroll_financial_setup_events
    WHERE company_id=$1 AND request_id=$2::uuid`,[input.companyId,input.requestId]);
  if (prior.rows.length) {
    if (prior.rows.length !== 1) fail("AUDIT_MISSING_OR_CHANGED");
    checkOpen(periods.rows[0],run);checkAudit(prior.rows[0],input,periods.rows[0]);
    return { periodId: periods.rows[0].id, auditEventId: prior.rows[0].id, created: false, replayed: true };
  }
  if (!['draft','reviewed'].includes(run.status) || run.posting_status !== 'pending' || run.accounting_entry_id !== null || run.payment_entry_id !== null)
    fail("RUN_NOT_ELIGIBLE");
  if (periods.rows.length === 1) {
    checkOpen(periods.rows[0],run);
    // Existing configured period is not a new registration or a new approval.
    return { periodId: periods.rows[0].id, auditEventId: null, created: false, replayed: false };
  }
  // Only three allowed INSERT columns. Defaults and existing audit triggers
  // enforce the new open/no-override state. No direct audit fabrication.
  const inserted = await client.query<Period>(`INSERT INTO public.financial_periods(company_id,month,year)
    VALUES($1,$2,$3) RETURNING ${periodFields}`,[input.companyId,run.month,run.year]);
  if (inserted.rowCount !== 1) fail("PERIOD_NOT_REGISTERED");
  checkOpen(inserted.rows[0],run);
  const audit = await client.query<Audit>(`SELECT ${auditFields} FROM public.payroll_financial_setup_events
    WHERE company_id=$1 AND request_id=$2::uuid`,[input.companyId,input.requestId]);
  if (audit.rows.length !== 1) fail("AUDIT_MISSING_OR_CHANGED");
  checkAudit(audit.rows[0],input,inserted.rows[0]);
  return { periodId: inserted.rows[0].id, auditEventId: audit.rows[0].id, created: true, replayed: false };
}
function retryable(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  return code === '40001' || code === '40P01';
}
export async function registerPayrollFinancialPeriod(pool: Pick<Pool,'connect'>, raw: PayrollPeriodRegistration) {
  const input = validate(raw);
  for (let attempt = 0; attempt < 3; attempt++) {
    let client: PoolClient;
    try { client = await pool.connect(); } catch { fail('CONNECTION_UNAVAILABLE'); }
    let discard: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await execute(client,input);
      if (!enabled()) fail('DEV_DISABLED');
      await client.query('COMMIT');
      return { ...result, companyId: input.companyId, runId: input.runId,
        payrollApproved: false as const, fundingApproved: false as const,
        accountingPosted: false as const, salaryPaid: false as const };
    } catch (error) {
      let rolledBack = false;
      try { await client.query('ROLLBACK'); rolledBack = true; }
      catch { discard = Error('PAYROLL_PERIOD_ROLLBACK_FAILED'); }
      if (rolledBack && retryable(error) && attempt < 2) continue;
      if (error instanceof Error && /^PAYROLL_PERIOD_[A-Z_]+$/.test(error.message)) throw error;
      fail('REGISTRATION_FAILED');
    } finally { client.release(discard); }
  }
  fail('REGISTRATION_FAILED');
}
