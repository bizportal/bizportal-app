import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import pg from "pg";
const {Pool,Client}=pg;
const root=process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL;
const bundle=process.env.CUSTOMER_INVOICE_DISPOSABLE_OWNER_PATH;
assert.equal(process.env.APP_ENV,"development");
assert.equal(process.env.NODE_ENV,"development");
assert.equal(process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV,"true");
assert(root&&bundle);
const parsed=new URL(root);
assert.equal(parsed.hostname,"127.0.0.1");
assert.equal(parsed.pathname,"/invoice_synthetic");
assert(bundle.endsWith("/portalInvoiceAdapter.mjs"));
const {postCustomerInvoiceWithOriginalOwner:post}=
 await import(pathToFileURL(bundle).href);
assert.equal(typeof post,"function");
async function makePool(user) {
  const client=new Client({connectionString:root,connectionTimeoutMillis:2000});
  await client.connect();
  // PostgreSQL16 superuser synthetic QA ONLY: assume NOLOGIN role's actual
  // session identity, proving CURRENT_USER=SESSION_USER and RLS on one socket.
  await client.query("SET SESSION AUTHORIZATION "+user);
  client.release=()=>{};
  return {
    query:(...args)=>client.query(...args),
    connect:async()=>client,
    end:async()=>client.end(),
  };
}
const cst=await makePool("bizportal_customer_invoice_cst_writer_dev");
const diva=await makePool("bizportal_customer_invoice_diva_writer_dev");
const admin=new Pool({connectionString:root,max:2,connectionTimeoutMillis:2000});
const tenants=[
 {pool:cst,company:1,opposite:3,id:195,role:"bizportal_customer_invoice_cst_writer_dev"},
 {pool:diva,company:3,opposite:1,id:197,role:"bizportal_customer_invoice_diva_writer_dev"},
];
async function checkLogin({pool,company,opposite,role}) {
 const {rows}=await pool.query(`SELECT current_user::text AS current_role,
  session_user::text AS login_role,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass_rls,
  row_security_active('public.sales_documents'::regclass) AS invoice_rls,
  row_security_active('public.accounting_entries'::regclass) AS gl_rls,
  row_security_active('public.accounting_entry_lines'::regclass) AS lines_rls,
  row_security_active('public.ar_subledger'::regclass) AS ar_rls,
  row_security_active('public.transaction_taxes'::regclass) AS tax_rls,
  row_security_active('public.audit_accounting_events'::regclass) AS audit_rls,
  row_security_active('public.financial_outbox_events'::regclass) AS outbox_rls`);
 const r=rows[0];assert.equal(r.current_role,role);assert.equal(r.login_role,role);
 assert.equal(r.bypass_rls,false);
 for(const k of ["invoice_rls","gl_rls","lines_rls","ar_rls","tax_rls","audit_rls","outbox_rls"])
  assert.equal(r[k],true,k);
 const foreign=await pool.query("SELECT id FROM public.sales_documents WHERE company_id=$1",[opposite]);
 assert.equal(foreign.rows.length,0,"no cross-company invoice visibility");
 const own=await pool.query("SELECT id FROM public.sales_documents WHERE company_id=$1",[company]);
 assert(own.rowCount>0);
 console.log("DIRECT_LOGIN_AND_RLS_PASS",company);
}
async function checkNegative({pool,company,opposite,role}) {
 const updated=await pool.query(
  "UPDATE public.sales_documents SET updated_at=now() WHERE company_id=$1 RETURNING id",
  [opposite]);
 assert.equal(updated.rowCount,0,"cross-company update denied");
 await pool.query("SELECT set_config('app.marketplace_company_id',$1,false)",[String(opposite)]);
 const spoof=await pool.query("SELECT id FROM public.sales_documents WHERE company_id=$1",[opposite]);
 assert.equal(spoof.rows.length,0,"user-controlled company GUC ignored");
 await pool.query("RESET app.marketplace_company_id");
 let denied=false;
 try {await pool.query("SET ROLE postgres")} catch(e){denied=true;}
 assert.equal(denied,true,"the login must not SET ROLE postgres");
 const state=await pool.query("select current_user::text AS user,session_user::text AS login");
 assert.equal(state.rows[0].user,role);
 assert.equal(state.rows[0].login,role);
 console.log("CROSS_COMPANY_AND_IMPERSONATION_DENIED_PASS",company);
}
async function issue({pool,company,id},rollback=false) {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const changed=await client.query(
   "UPDATE public.sales_documents SET updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING id,company_id,invoice_number,grand_total",
   [id,company]);
  assert.equal(changed.rowCount,1,"single scoped invoice lock");
  const receipt=await post({
   query:(sql,values)=>client.query(sql,values),
   transactionClient:client,
   companyId:company,source:"sales_invoice",sourceId:id,
   invoice:changed.rows[0],actorId:"synthetic-owner",
  });
  assert.equal(receipt.posted,true);
  assert(Number.isSafeInteger(receipt.entryId)&&receipt.entryId>0);
  await client.query(rollback?"ROLLBACK":"COMMIT");
  console.log(rollback?"COMPANY_SCOPED_ROLLBACK_ACTION_PASS":"COMPANY_SCOPED_COMMIT_PASS",
   company,id,receipt.entryId);
  return receipt.entryId;
 }catch(error) {
  await client.query("ROLLBACK").catch(()=>{});
  throw error;
 }finally{client.release()}
}
async function count(table,company,id) {
 const filter=table==="accounting_entries"
  ? "company_id=$1 AND source='sales_invoice' AND source_id=$2"
  : table==="ar_subledger"?"company_id=$1 AND invoice_id=$2"
  : table==="transaction_taxes"?"company_id=$1 AND transaction_type='sales_invoice' AND transaction_id=$2"
  : "company_id=$1 AND entry_id IN (SELECT id FROM public.accounting_entries WHERE company_id=$1 AND source='sales_invoice' AND source_id=$2)";
 const r=await admin.query("SELECT count(*)::int as n FROM public."+table+" WHERE "+filter,[company,id]);
 return Number(r.rows[0].n);
}
async function verify({company,id}) {
 for(const table of ["accounting_entries","ar_subledger","transaction_taxes",
                      "ledger_events","financial_outbox_events"])
  assert.equal(await count(table,company,id),1,"exactly one "+table+" for "+id);
 const gl=await admin.query(
  "SELECT id,total_debit,total_credit,status::text AS status FROM public.accounting_entries WHERE company_id=$1 AND source='sales_invoice' AND source_id=$2",
  [company,id]);
 assert.equal(gl.rows.length,1);
 assert.equal(gl.rows[0].status,"posted");
 assert.equal(Number(gl.rows[0].total_debit),111);
 assert.equal(Number(gl.rows[0].total_credit),111);
 const lines=await admin.query(
  "SELECT count(*)::int AS n,sum(debit) AS dr,sum(credit) AS cr FROM public.accounting_entry_lines WHERE entry_id=$1",
  [gl.rows[0].id]);
 assert.equal(lines.rows[0].n,3);
 assert.equal(Number(lines.rows[0].dr),111);
 assert.equal(Number(lines.rows[0].cr),111);
 console.log("COMPANY_SCOPED_ORIGINAL_GL_PPN_AR_OUTBOX_PASS",company,id);
}
try {
 for(const tenant of tenants) {
  await checkLogin(tenant);
  await checkNegative(tenant);
 }
 for(const tenant of tenants){await issue(tenant);await verify(tenant)}
 for(const tenant of tenants){await issue(tenant);await verify(tenant)}
 console.log("COMPANY_SCOPED_IDEMPOTENT_REPLAY_PASS");
 await issue({...tenants[0],id:199},true);
 for(const table of ["accounting_entries","ar_subledger","transaction_taxes",
                      "ledger_events","financial_outbox_events"])
  assert.equal(await count(table,1,199),0,"rollback left "+table);
 console.log("COMPANY_SCOPED_ROLLBACK_CLEAN_PASS");
} finally {
 await Promise.all([cst.end(),diva.end(),admin.end()]);
}
