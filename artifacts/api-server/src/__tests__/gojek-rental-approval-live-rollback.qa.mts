/**
 * Live CST-DEV disposable test, not auto-run in CI.
 * Uses the pre-existing role-pinned Finance adapter, never a service-role
 * or forged signed-OTP session. An intentional throw forces ROLLBACK.
 */
import { withFleetFinanceDevTransaction } from "../../../../lib/db/src/fleet-finance-dev";

const scope={sourceCompanyId:1,companyId:3};
const codes=["1-1025-DV","1-1035-DV","4-1026-DV","4-1027-DV"];
if(process.env.APP_ENV!=="development" || process.env.FLEET_FINANCE_WRITE_ENABLED==="true" ||
   process.env.BIZPORTAL_FLEET_GOJEK_APPROVAL_ENABLED_DEV!=="true")
  throw Error("QA_REQUIRES_DEV_APPROVAL_ONLY_AND_FINANCE_WRITER_OFF");

const baseline=await withFleetFinanceDevTransaction(scope,async client=>{
 const r=await client.query(`SELECT code,approved_by,approved_at FROM public.chart_of_accounts
  WHERE company_id=3 AND code=ANY($1::text[]) ORDER BY code`,[codes]);
 if(r.rows.length!==4||r.rows.some((row:any)=>row.approved_by!=null||row.approved_at!=null))
  throw Error("QA_EXPECTED_FOUR_UNAPPROVED_COAS");
 return r.rows;
},{readOnly:true});

let rollbackObserved=false;
try {
 await withFleetFinanceDevTransaction(scope,async client=>{
  await client.query("SELECT set_config('app.fleet_approval_actor',$1,true)",["qa-rollback@invalid.example"]);
  const r=await client.query(`UPDATE public.chart_of_accounts
    SET approved_by=$1,approved_at=NOW(),updated_at=NOW()
    WHERE company_id=3 AND code=ANY($2::text[]) AND approved_by IS NULL AND approved_at IS NULL
    RETURNING code`,["qa-rollback@invalid.example",codes]);
  if(r.rowCount!==4)throw Error("QA_APPROVAL_UPDATE_NOT_FOUR");
  throw Error("QA_EXPECTED_FORCED_ROLLBACK");
 },{approvalOnly:true});
}catch(error){
 if(error instanceof Error&&error.message==="QA_EXPECTED_FORCED_ROLLBACK")rollbackObserved=true;
 else throw error;
}
if(!rollbackObserved)throw Error("QA_ROLLBACK_NOT_TRIGGERED");
const after=await withFleetFinanceDevTransaction(scope,async client=>{
 const r=await client.query(`SELECT code,approved_by,approved_at FROM public.chart_of_accounts
 WHERE company_id=3 AND code=ANY($1::text[]) ORDER BY code`,[codes]);
 return r.rows;
},{readOnly:true});
if(JSON.stringify(after)!==JSON.stringify(baseline))throw Error("QA_ROLLBACK_LEFT_CHANGES");
console.log("GOJEK_APPROVAL_DEV_POSTGRES_ROLLBACK_PASS",JSON.stringify({
 scope,qaApprovedInsideUncommittedTransaction:4,stillPendingAfterRollback:after.length,
 financialPostingEnabled:false
}));
