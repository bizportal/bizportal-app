import assert from "node:assert/strict";
import pg from "pg";
const {Pool}=pg,root=process.env.CUSTOMER_INVOICE_DISPOSABLE_DB_URL;
assert(root&&new URL(root).hostname==="127.0.0.1" &&
 new URL(root).pathname==="/invoice_synthetic");
const admin=new Pool({connectionString:root,max:1});
for(const [role,pass,company,invoice,customer,otherInvoice,foreignCustomer]of [
 ["bizportal_customer_invoice_cst_writer_dev","local-qa-cst-only",1,195,11,197,13],
 ["bizportal_customer_invoice_diva_writer_dev","local-qa-diva-only",3,197,13,195,11],
]){
 const u=new URL(root);u.username=role;u.password=pass;
 const client=new Pool({connectionString:u.toString(),max:1});
 try{
  const owner=await client.query(`SELECT id,role,system_role,status,is_active,company_id
   FROM public.users WHERE lower(trim(email))=lower(trim($1))
   AND role='super_admin' AND system_role='super_admin' AND status='active'
   AND is_active IS TRUE LIMIT 2 FOR SHARE`,["qa-superadmin@example.invalid"]);
  assert.equal(owner.rowCount,1,"actual handler FOR SHARE under direct writer");
  console.log("REAL_HANDLER_SUPERADMIN_OWNER_LOCK_PASS",company);
  let denied=false;
  try{await client.query("UPDATE public.users SET updated_at=clock_timestamp() WHERE id=$1",["qa-admin-global"])}
  catch(e){denied=true;assert.equal(e.code,"42501")}
  assert(denied,"Super Admin row must remain immutable");
  const recipients=await client.query(`SELECT id FROM public.portal_customers
    WHERE $1::int IS NOT NULL AND id=$1::int
    UNION SELECT pcm.portal_customer_id AS id FROM public.portal_company_members pcm
    WHERE $2::int IS NOT NULL AND pcm.company_id=$2::int AND pcm.is_active=true`,
    [customer,company]);
  assert.deepEqual(recipients.rows.map(x=>Number(x.id)).sort((a,b)=>a-b),[customer]);
  const admins=await client.query("SELECT id FROM public.portal_customers WHERE role='admin' AND coalesce(account_status,'active')='active'");
  assert.deepEqual(admins.rows.map(x=>Number(x.id)),[20]);
  const activityKey="sales-invoice-issued:"+invoice;
  const activitySql=`INSERT INTO public.activity_logs
    (actor_type,actor_id,actor_name,action,old_value,new_value,description,deduplication_key)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)
    ON CONFLICT(deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING`;
  const activityArgs=[
   "admin","20","QA Portal Admin","sales_invoice_issued",
   JSON.stringify({invoiceStatus:"to_invoice"}),
   JSON.stringify({invoiceStatus:"invoiced",invoiceNumber:"QA-"+company+"-"+invoice}),
   "QA disposable invoice",activityKey];
  await client.query(activitySql,activityArgs);
  await client.query(activitySql,activityArgs);
  const notifySql=`INSERT INTO public.portal_customer_notifications
    (portal_customer_id,event_key,type,title,message,payload)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT(portal_customer_id,event_key) DO NOTHING`;
  const eventKey="sales-invoice:"+invoice+":invoiced";
  for(const recipient of [customer,20]){
    const args=[recipient,eventKey,"sales_invoice_issued","QA Invoice",
      "QA disposable invoice notification",
      JSON.stringify({invoiceId:invoice,invoiceNumber:"QA-"+company+"-"+invoice})];
    await client.query(notifySql,args);
    await client.query(notifySql,args);
  }
  console.log("REAL_HANDLER_AUDIT_AND_NOTIFICATION_SQL_PASS",company);
  let crossDenied=false;
  try {
    await client.query(activitySql,[...activityArgs.slice(0,-1),"sales-invoice-issued:"+otherInvoice]);
  }catch(e){crossDenied=true;assert.equal(e.code,"42501")}
  assert(crossDenied,"cross-company activity must be denied");
  crossDenied=false;
  try {
    await client.query(notifySql,[foreignCustomer,
      "sales-invoice:"+otherInvoice+":invoiced","sales_invoice_issued",
      "Invalid foreign invoice","Blocked",
      JSON.stringify({invoiceId:otherInvoice})]);
  }catch(e){crossDenied=true;assert.equal(e.code,"42501")}
  assert(crossDenied,"cross-company notification must be denied");
  console.log("HANDLER_CROSS_COMPANY_NOTIFICATION_DENIED_PASS",company);
 }finally{await client.end()}
 const act=await admin.query(
   "SELECT count(*)::int AS n FROM public.activity_logs WHERE deduplication_key=$1",
   ["sales-invoice-issued:"+invoice]);
 assert.equal(act.rows[0].n,1);
 const notif=await admin.query(
   "SELECT count(*)::int AS n FROM public.portal_customer_notifications WHERE event_key=$1",
   ["sales-invoice:"+invoice+":invoiced"]);
 assert.equal(notif.rows[0].n,2);
}
await admin.end();
console.log("REAL_HANDLER_PRIVILEGE_READ_LOCK_AUDIT_NOTIFICATION_PASS");
