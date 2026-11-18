import assert from "node:assert/strict";
import pg from "pg";
const {Pool}=pg, root=process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL;
assert(root && new URL(root).hostname==="127.0.0.1" &&
 new URL(root).pathname==="/invoice_synthetic");
const admin=new Pool({connectionString:root,max:1});
for(const [role,pass,id,foreign] of [
 ["bizportal_customer_invoice_cst_writer_dev","local-qa-cst-only",1,3],
 ["bizportal_customer_invoice_diva_writer_dev","local-qa-diva-only",3,1],
]){
 const url=new URL(root);url.username=role;url.password=pass;
 const pool=new Pool({connectionString:url.toString(),max:1});
 try {
   const result=await pool.query("SELECT id FROM public.qa_owner_user WHERE id=$1 FOR SHARE",[id]);
   console.log("OWNER_LOCK_WITH_NO_WRITE_POLICY",role,"ROWS",result.rowCount);
   const original=(await admin.query("SELECT updated_at FROM public.qa_owner_user WHERE id=$1",[id])).rows[0].updated_at;
   try {
     const upd=await pool.query("UPDATE public.qa_owner_user SET updated_at=clock_timestamp() WHERE id=$1 RETURNING id",[id]);
     console.log("OWNER_UPDATE_ATTEMPT_RETURNED",role,"ROWS",upd.rowCount);
     assert.equal(upd.rowCount,0,"write must not succeed");
   }catch(error){console.log("OWNER_UPDATE_ATTEMPT_BLOCKED",role,"ERROR",error.code);}
   const after=(await admin.query("SELECT updated_at FROM public.qa_owner_user WHERE id=$1",[id])).rows[0].updated_at;
   assert.equal(Number(after),Number(original),"user row immutable");
   const cross=await pool.query("SELECT id FROM public.qa_owner_user WHERE id=$1 FOR SHARE",[foreign]);
   assert.equal(cross.rowCount,0,"foreign row lock invisible");
 }finally{await pool.end()}
}
await admin.end();
