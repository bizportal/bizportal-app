import type { IRouter, Request, Response } from "express";
import type { PayrollDbClient } from "@workspace/db";
import { getPayrollPool, payrollDedicatedEnabled, setPayrollCompanyScope } from "./payroll-db";
import { isDevelopmentEnvironment } from "./dev-auth";

type ScopedRequest = Request & {
  payrollCompanyId?: number;
  payrollActor?: { id?: number|string; email?: string; role: string };
};
type SourceRow = Record<string,unknown>;
const MAX_ACTIVE = 200;
// Restored from mirror PR #97. Canonical Payroll middleware supplies signed actor/company scope.

function parsePositiveId(raw:unknown):number|null {
  if(typeof raw!=="string" || !/^[1-9][0-9]*$/.test(raw)) return null;
  const v=Number(raw); return Number.isSafeInteger(v)?v:null;
}
function parseAmount(raw:unknown):bigint|null {
  if(typeof raw!=="string" || !/^-?\d+(?:\.\d{1,2})?$/.test(raw))return null;
  const negative=raw.startsWith("-");
  const plain=negative?raw.slice(1):raw;
  const [whole,decimal=""]=plain.split(".");
  const cents=BigInt(whole)*100n+BigInt(decimal.padEnd(2,"0"));
  return negative?-cents:cents;
}
function formatAmount(cents:bigint):string {
  const neg=cents<0n,abs=neg?-cents:cents;
  return (neg?"-":"")+(abs/100n).toString()+"."+(abs%100n).toString().padStart(2,"0");
}

/**
 * Existing master employees.salary is an unclassified legacy amount.
 * Comparing it to a configured base+allowance never establishes that
 * the legacy column is base salary, gross salary, allowance or net salary.
 * This endpoint CANNOT import or change anything.
 */
export function registerPayrollLegacySalaryComparisonRoutes(router:IRouter):void {
  router.get("/payroll/runs/:id/legacy-salary-comparison",
    async(req:ScopedRequest,res:Response):Promise<void>=>{
      res.setHeader("Cache-Control","no-store");
      let client:PayrollDbClient|undefined,transaction=false;
      try {
        if(!isDevelopmentEnvironment() || process.env.APP_ENV!=="development") {
          res.status(404).json({message:"Pratinjau gaji lama hanya tersedia di DEV."});return;
        }
        const actor=req.payrollActor;
        if(!actor || !["owner","super_admin"].includes(actor.role.toLowerCase()) || !String(actor.id??"").trim()) {
          res.status(403).json({message:"Pratinjau hanya untuk Owner/Super Admin."});return;
        }
        const runId=parsePositiveId(req.params.id),companyId=req.payrollCompanyId;
        if(!runId || !Number.isSafeInteger(companyId) || (companyId??0)<=0) {
          res.status(400).json({message:"Perusahaan atau periode Payroll tidak valid."});return;
        }
        if(!payrollDedicatedEnabled()){
          res.status(503).json({message:"Koneksi khusus Payroll DEV tidak tersedia."});return;
        }
        client=await getPayrollPool().connect();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");transaction=true;
        await setPayrollCompanyScope(client,companyId!);
        const run=await client.query(`
          SELECT id,month,year,status FROM public.payroll_runs
          WHERE company_id=$1 AND id=$2
        `,[companyId,runId]);
        if(run.rowCount!==1){res.status(404).json({message:"Periode Payroll tidak ditemukan pada perusahaan ini."});return;}
        if(run.rows[0].status!=="draft"){res.status(409).json({message:"Pratinjau hanya untuk periode Draft."});return;}
        const month=Number(run.rows[0].month),year=Number(run.rows[0].year);
        if(!Number.isSafeInteger(year)||year<2020||year>2100 || !Number.isSafeInteger(month)||month<1||month>12)
          throw Error("INVALID_PERIOD");
        const cutoff=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
        const accounts=await client.query(`
          SELECT e.id,e.first_name,e.last_name,
            CASE WHEN e.salary IS NULL THEN NULL ELSE ROUND(e.salary::numeric,2)::text END AS legacy_salary,
            p.base_salary::text AS base_salary,p.allowance::text AS allowance,
            p.effective_from::text AS effective_from
          FROM public.employees e
          LEFT JOIN LATERAL (
            SELECT s.base_salary,s.allowance,s.effective_from FROM public.payroll_salary_profiles s
            WHERE s.company_id=$1 AND s.employee_id=e.id AND s.effective_from<=$2::date
            ORDER BY s.effective_from DESC,s.id DESC LIMIT 1
          ) p ON TRUE
          WHERE e.company_id=$1 AND e.status='active' AND e.deleted_at IS NULL
          ORDER BY e.id LIMIT ${MAX_ACTIVE+1}
        `,[companyId,cutoff]);
        if(accounts.rows.length>MAX_ACTIVE){
          res.status(409).json({message:"Terlalu banyak karyawan untuk pratinjau aman. Data tidak dipotong diam-diam."});return;
        }
        let legacySum=0n,configuredSum=0n,legacyCount=0,missingProfileCount=0,matchCount=0,diffCount=0;
        const rows=accounts.rows.map((e:SourceRow)=>{
          const legacy=parseAmount(e.legacy_salary);
          const base=parseAmount(e.base_salary),allowance=parseAmount(e.allowance);
          const hasProfile=e.effective_from!==null&&e.effective_from!==undefined;
          const validProfile=hasProfile&&base!==null&&allowance!==null&&base>=0n&&allowance>=0n;
          const configured=validProfile?base+allowance:null;
          if(legacy!==null&&legacy>0n){legacySum+=legacy;legacyCount++;}
          if(validProfile&&configured!==null)configuredSum+=configured;
          else missingProfileCount++;
          if(validProfile&&configured!==null&&legacy!==null&&legacy>0n){
            if(configured===legacy)matchCount++;else diffCount++;
          }
          return {
            employeeId:Number(e.id),employeeName:[String(e.first_name??""),String(e.last_name??"")].join(" ").trim(),
            legacySalary:legacy===null?null:formatAmount(legacy),
            configuredBaseSalary:validProfile?formatAmount(base!):null,
            configuredAllowance:validProfile?formatAmount(allowance!):null,
            configuredTotal:configured===null?null:formatAmount(configured),
            differenceFromLegacy:configured===null||legacy===null?null:formatAmount(configured-legacy),
            effectiveFrom:hasProfile?String(e.effective_from):null,
            status:legacy===null||legacy<=0n?"LEGACY_AMOUNT_INVALID"
              :!validProfile?"SALARY_COMPONENTS_NOT_CONFIGURED"
              :configured===legacy?"NUMBERS_MATCH_COMPONENTS_UNVERIFIED"
              :"AMOUNTS_DIFFER_COMPONENTS_UNVERIFIED",
            componentsVerified:false,
          };
        });
        await client.query("COMMIT");transaction=false;
        res.json({
          companyId,runId,month,year,effectiveThrough:cutoff,source:"public.employees.salary",
          legacyAmountSemantics:"UNKNOWN",
          activeEmployees:rows.length,withPositiveLegacyAmount:legacyCount,
          withoutEffectiveSalaryProfile:missingProfileCount,
          numericMatches:matchCount,numericDifferences:diffCount,
          legacyReferenceTotal:legacyCount?formatAmount(legacySum):null,
          configuredComparisonTotal:missingProfileCount<rows.length?formatAmount(configuredSum):null,
          rows,
          readOnly:true,componentsVerified:false,canImport:false,canMaterialize:false,
          canApprove:false,canPost:false,canPay:false,
          note:"Kolom salary lama belum teridentifikasi sebagai gaji pokok, kotor, bersih atau sudah termasuk uang makan. Pratinjau ini bukan instruksi memindahkan nilai atau membuat pembayaran.",
        });
      }catch(error){
        req.log?.error?.({code:(error as {code?:string})?.code||"READ_FAILED"},"DEV legacy salary comparison failed");
        res.status(503).json({message:"Pratinjau gaji historis tidak dapat dibaca. Tidak ada perubahan disimpan.",canImport:false,canPost:false,canPay:false});
      }finally{
        if(client&&transaction)try{await client.query("ROLLBACK");}catch{/* preserve original */}
        client?.release();
      }
    });
}
