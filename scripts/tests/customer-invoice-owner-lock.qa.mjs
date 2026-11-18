import assert from "node:assert/strict";
import pg from "pg";
const {Pool}=pg;
const url=process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL;
assert(url && new URL(url).hostname==="127.0.0.1" &&
  new URL(url).pathname==="/invoice_synthetic");
const admin=new Pool({connectionString:url,max:1});
const roles=[
  ["bizportal_customer_invoice_cst_writer_dev","local-qa-cst-only",1,3],
  ["bizportal_customer_invoice_diva_writer_dev","local-qa-diva-only",3,1],
];
for(const [role,pass,id,foreign] of roles) {
 const u=new URL(url);u.username=role;u.password=pass;
 const scoped=new Pool({connectionString:u.toString(),max:1});
 try {
  try {
   const r=await scoped.query("SELECT id FROM public.qa_owner_user WHERE id=$1 FOR SHARE",[id]);
   console.log("WITHOUT_UPDATE_GRANT_STATUS",role,"ROWS",r.rowCount);
  }catch(e){console.log("WITHOUT_UPDATE_GRANT_STATUS",role,"ERROR",e.code);}
  await admin.query("GRANT UPDATE(updated_at) ON public.qa_owner_user TO "+role);
  try {
   const r=await scoped.query("SELECT id FROM public.qa_owner_user WHERE id=$1 FOR SHARE",[id]);
   console.log("WITH_UPDATE_COLUMN_BUT_DENY_POLICY_STATUS",role,"ROWS",r.rowCount);
  }catch(e){console.log("WITH_UPDATE_COLUMN_BUT_DENY_POLICY_STATUS",role,"ERROR",e.code);}
  try {
   const r=await scoped.query("UPDATE public.qa_owner_user SET updated_at=clock_timestamp() WHERE id=$1 RETURNING id",[id]);
   console.log("ACTUAL_USER_UPDATE_DENIED_RESULT",role,"ROWS",r.rowCount);
   assert.equal(r.rowCount,0);
  }catch(e){console.log("ACTUAL_USER_UPDATE_DENIED_ERROR",role,"CODE",e.code);}
  const foreignRows=await scoped.query("SELECT id FROM public.qa_owner_user WHERE id=$1",[foreign]);
  assert.equal(foreignRows.rowCount,0);
 }finally{await scoped.end();}
}
await admin.end();
