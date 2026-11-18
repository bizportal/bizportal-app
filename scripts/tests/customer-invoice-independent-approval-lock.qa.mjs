// Disposable PostgreSQL16 security test for PR214 authorization SQL,
 // using two real direct-login NO-BYPASS tenant roles (no shared DEV).
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import pg from "pg";
const {Pool}=pg;
const raw=process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL;
assert(raw,"disposable PostgreSQL URL required");
const parsed=new URL(raw);
assert.equal(parsed.hostname,"127.0.0.1");
assert.equal(parsed.pathname,"/invoice_synthetic");
assert.equal(process.env.APP_ENV,"development");
const QUERY=`select 1 as approved
       from public.portal_company_requests approval
       join public.portal_company_members member
         on member.portal_customer_id=approval.portal_customer_id
        and member.company_id=approval.matched_company_id
        and member.is_active=true
       join public.portal_customers reviewer
         on reviewer.id=approval.reviewed_by
        and reviewer.role='admin'
        and (reviewer.account_status='active' or reviewer.account_status is null)
       join public.portal_customers issuer
         on issuer.id=approval.portal_customer_id
        and issuer.role='admin'
        and (issuer.account_status='active' or issuer.account_status is null)
      where approval.portal_customer_id=$1
        and approval.matched_company_id=$2
        and approval.status='approved'
        and approval.reviewed_by is not null
        and approval.reviewed_by<>$1
        and approval.reviewed_at is not null
      limit 1
      for share of member, approval, reviewer, issuer`;
if(process.env.CUSTOMER_PORTAL_PR220_SOURCE_FILE){
 const source=readFileSync(process.env.CUSTOMER_PORTAL_PR220_SOURCE_FILE,"utf8");
 const excerpts=[...source.matchAll(/`select 1 as approved[\s\S]*?for share of member, approval, reviewer, issuer`/g)];
 assert.equal(excerpts.length,1,"one canonical company approval SQL in source");
 assert.equal(excerpts[0][0].slice(1,-1).trim(),QUERY.trim(),
   "checked real Portal original authorization SQL, not separate implementation");
 console.log("EXACT_PORTAL_PR220_AUTH_SQL_PARITY_PASS");
}
const admin=new Pool({connectionString:raw,max:2,connectionTimeoutMillis:2500});
const tenants=[
 {company:1,other:3,role:"bizportal_customer_invoice_cst_writer_dev",password:"local-qa-cst-only"},
 {company:3,other:1,role:"bizportal_customer_invoice_diva_writer_dev",password:"local-qa-diva-only"},
];
function rolePool(t){
 const u=new URL(raw);u.username=t.role;u.password=t.password;
 return new Pool({connectionString:u.toString(),max:2,connectionTimeoutMillis:2500});
}
async function directSessionCheck(t,pool){
 const result=await pool.query(`
   SELECT current_user::text AS role,session_user::text AS login,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass,
    row_security_active('public.portal_company_requests'::regclass) AS approval_rls,
    row_security_active('public.portal_company_members'::regclass) AS member_rls,
    row_security_active('public.portal_customers'::regclass) AS admin_rls`);
 const row=result.rows[0];
 assert.equal(row.role,t.role);assert.equal(row.login,t.role);
 assert.equal(row.bypass,false);
 for(const name of ["approval_rls","member_rls","admin_rls"]) assert.equal(row[name],true,name);
 const authorized=await pool.query(QUERY,[20,t.company]);
 assert.equal(authorized.rowCount,1,"independent approval visible under direct company login");
 const foreign=await pool.query(QUERY,[20,t.other]);
 assert.equal(foreign.rowCount,0,"cross-company approval hidden");
 const self=await pool.query(QUERY,[21,t.company]);
 assert.equal(self.rowCount,0,"reviewer cannot inherit issuer authority");
 console.log("DIRECT_COMPANY_APPROVED_AUTH_FOR_SHARE_PASS",t.company);
}
async function expectDeniedMutation(t,pool){
 const updates=[
  ["portal_company_members","updated_at=clock_timestamp()","portal_customer_id=20 AND company_id=$1"],
  ["portal_company_requests","updated_at=clock_timestamp()","portal_customer_id=20 AND matched_company_id=$1"],
  ["portal_customers","status_changed_at=clock_timestamp()","id=20"],
 ];
 for(const [table,set,filter] of updates){
  try{
    const result=await pool.query(`UPDATE public.${table} SET ${set} WHERE ${filter} RETURNING id`,
     filter.includes("$1")?[t.company]:[]);
    assert.equal(result.rowCount,0,"must not update "+table);
  }catch(error){assert.equal(error.code,"42501","deny "+table);}
 }
 console.log("COMPANY_APPROVAL_AND_ADMIN_ROWS_IMMUTABLE_PASS",t.company);
}
async function assertRevocationBlockedUntilCommit(t,pool,kind){
 const direct=await pool.connect();
 const privileged=await admin.connect();
 const table=kind==="member"?"portal_company_members":"portal_company_requests";
 const filter=kind==="member"
  ?"portal_customer_id=20 AND company_id=$1"
  :"portal_customer_id=20 AND matched_company_id=$1";
 const set=kind==="member"?"is_active=false":"status='rejected'";
 const restore=kind==="member"?"is_active=true":"status='approved'";
 try{
  await direct.query("BEGIN");
  assert.equal((await direct.query(QUERY,[20,t.company])).rowCount,1);
  await privileged.query("BEGIN");
  await privileged.query("SET LOCAL lock_timeout='250ms'");
  await assert.rejects(
   privileged.query(`UPDATE public.${table} SET ${set} WHERE ${filter}`,[t.company]),
   e=>e?.code==="55P03",
   "revocation must wait for committed financial authority");
  await privileged.query("ROLLBACK");
  await direct.query("COMMIT");
  await privileged.query(`UPDATE public.${table} SET ${set} WHERE ${filter}`,[t.company]);
  assert.equal((await pool.query(QUERY,[20,t.company])).rowCount,0);
  await privileged.query(`UPDATE public.${table} SET ${restore} WHERE ${filter}`,[t.company]);
  assert.equal((await pool.query(QUERY,[20,t.company])).rowCount,1);
  console.log("COMPANY_APPROVAL_REVOCATION_LOCK_PASS",t.company,kind);
 }finally{
  await direct.query("ROLLBACK").catch(()=>{});
  await privileged.query("ROLLBACK").catch(()=>{});
  direct.release();privileged.release();
 }
}
try{
 for(const t of tenants){
  const pool=rolePool(t);
  try{
   await directSessionCheck(t,pool);
   await expectDeniedMutation(t,pool);
   await assertRevocationBlockedUntilCommit(t,pool,"member");
   await assertRevocationBlockedUntilCommit(t,pool,"approval");
   // Reviewer must remain active and independent, even after prior approval.
   await admin.query("UPDATE public.portal_customers SET role='customer' WHERE id=21");
   assert.equal((await pool.query(QUERY,[20,t.company])).rowCount,0);
   await admin.query("UPDATE public.portal_customers SET role='admin' WHERE id=21");
   await admin.query("UPDATE public.portal_company_requests SET reviewed_by=20 WHERE portal_customer_id=20 AND matched_company_id=$1",[t.company]);
   assert.equal((await pool.query(QUERY,[20,t.company])).rowCount,0);
   await admin.query("UPDATE public.portal_company_requests SET reviewed_by=21 WHERE portal_customer_id=20 AND matched_company_id=$1",[t.company]);
   assert.equal((await pool.query(QUERY,[20,t.company])).rowCount,1);
   console.log("INDEPENDENT_REVIEWER_ROLE_AND_SELF_APPROVAL_DENIED_PASS",t.company);
  }finally{await pool.end()}
 }
 console.log("SCOPED_INVOICE_APPROVAL_RLS_ROW_LOCK_E2E_PASS");
}finally{await admin.end()}
