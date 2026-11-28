import {loadAutoKasbonSources,type ScopedQuery} from "./payroll-kasbon-draft-db";
import {overlayAutomaticKasbon,finalizeAutomaticKasbonPreview} from "./payroll-kasbon-draft-overlay";
import {buildEffectiveSetupPreview,periodEnd,type EffectiveSalaryRow,type EffectiveDeductionRow} from "./payroll-setup-effective-preview";

/** Port the original effective-dated GET projection, not its materialization writer.
 * The caller owns a single company-scoped read-only transaction. */
export async function loadEffectivePayrollSetupPreview(query:ScopedQuery,companyId:number,runId:number){
  if(!Number.isSafeInteger(companyId)||companyId<1||!Number.isSafeInteger(runId)||runId<1)
    throw Error("INVALID_PAYROLL_PREVIEW_SCOPE");
  const run=await query("SELECT id,month,year,status FROM public.payroll_runs WHERE company_id=$1 AND id=$2 LIMIT 1",[companyId,runId]);
  if(run.rows.length!==1)return {kind:"missing" as const};
  if(run.rows[0].status!=="draft")return {kind:"not_draft" as const};
  const year=Number(run.rows[0].year),month=Number(run.rows[0].month);
  const effectiveThrough=periodEnd(year,month);
  const employees=await query(
    'SELECT e.id AS "employeeId",e.first_name AS "firstName",e.last_name AS "lastName", '+
    'p.base_salary::text AS "baseSalary",p.allowance::text AS "allowance",p.effective_from::text AS "salaryEffectiveFrom" '+
    "FROM public.employees e LEFT JOIN LATERAL ("+
    " SELECT s.base_salary,s.allowance,s.effective_from FROM public.payroll_salary_profiles s"+
    " WHERE s.company_id=$1::bigint AND s.employee_id=e.id AND s.effective_from<=$2::date"+
    " ORDER BY s.effective_from DESC,s.id DESC LIMIT 1"+
    ") p ON TRUE WHERE e.company_id=$1::bigint AND e.status='active' AND e.deleted_at IS NULL"+
    " ORDER BY e.first_name,e.last_name,e.id",[companyId,effectiveThrough]);
  const deductions=await query(
    'SELECT DISTINCT ON (d.employee_id,d.code) d.employee_id AS "employeeId",d.code,'+
    'd.amount::text AS amount,d.effective_from::text AS "effectiveFrom",d.notes '+
    "FROM public.payroll_deduction_settings d JOIN public.employees e ON e.id=d.employee_id AND e.company_id=$1::bigint"+
    " WHERE d.company_id=$1::bigint AND d.effective_from<=$2::date AND e.status='active' AND e.deleted_at IS NULL"+
    " ORDER BY d.employee_id,d.code,d.effective_from DESC,d.id DESC",[companyId,effectiveThrough]);
  const roster=employees.rows as unknown as EffectiveSalaryRow[];
  const sources=await loadAutoKasbonSources(query,companyId,roster.map(r=>Number(r.employeeId)));
  const auto=overlayAutomaticKasbon(roster,deductions.rows as unknown as EffectiveDeductionRow[],
    sources.advances,sources.plans,sources.reservations,companyId,runId,year,month);
  const preview=finalizeAutomaticKasbonPreview(buildEffectiveSetupPreview(roster,auto.deductions,year,month),auto);
  return {kind:"ok" as const,preview:{companyId,runId,year,month,...preview,readOnly:true as const,
    persisted:false as const,canMaterialize:false as const,readyForPayment:false as const}};
}
