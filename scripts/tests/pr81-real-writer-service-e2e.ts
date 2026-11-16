/**
 * Runs the existing, unmodified mktApPreparationService functions against an
 * isolated PostgreSQL 16. All database changes are inside an outer ROLLBACK.
 * Drizzle schema columns come directly from the canonical app definitions.
 * No live Finance helper credentials or external notification callbacks.
 */
import assert from "node:assert/strict";
import {sql,getTableColumns} from "drizzle-orm";
import {
 db,pool,afterCommitActions,mktApPreparationsTable,mktAccountingHandoffsTable,
 paymentRequestsTable,mktPoGoodsReceiptsTable,mktPoShipmentsTable,
 mktPurchaseOrdersTable,vendorInvoicesTable,
} from "./pr81-real-writer-db-stub";
import {
 createApPreparation,reviewApPreparation,markApPreparationWaitingPayment,
 createMarketplaceAccountingHandoff,getApPreparation,
} from "../../artifacts/api-server/src/lib/services/mktApPreparationService";

const tables=[
 mktPurchaseOrdersTable,mktPoShipmentsTable,mktPoGoodsReceiptsTable,
 vendorInvoicesTable,mktApPreparationsTable,paymentRequestsTable,
 mktAccountingHandoffsTable
];
const allowed=new Set(["mkt_purchase_orders","mkt_po_shipments","mkt_po_goods_receipts",
 "vendor_invoices","mkt_ap_preparations","payment_requests","mkt_accounting_handoffs"]);
const writer="ci_pr81_real_writer";
const tenant="nullif(current_setting('app.marketplace_company_id',true),'')::int";
class RollbackComplete extends Error {}
function tableName(table:any){
 const name=table[Symbol.for("drizzle:Name")];
 assert(allowed.has(name));
 return name as string;
}
function ddl(table:any):string{
 const name=tableName(table);
 const columns=Object.values(getTableColumns(table)).map((col:any)=>{
  const type=col.getSQLType();
  assert(/^(serial|integer|text|timestamp|date|boolean|jsonb|numeric\(\d+, \d+\)|mkt_po_status|vi_status|pay_req_status|mkt_ap_preparation_status)$/.test(type),type);
  let definition='"'+col.name+'" '+type;
  if(type==="serial")return definition+" PRIMARY KEY";
  if(col.notNull)definition+=" NOT NULL";
  if(col.hasDefault){
   if(col.dataType==="date")definition+=" DEFAULT now()";
   else if(typeof col.default==="string")
    definition+=" DEFAULT '"+col.default.replaceAll("'","''")+"'";
   else if(typeof col.default==="number")definition+=" DEFAULT "+col.default;
   else if(typeof col.default==="boolean")definition+=" DEFAULT "+String(col.default);
   else throw new Error("Unknown SQL default for "+name+"."+col.name);
  }
  return definition;
 });
 return 'CREATE TABLE public."'+name+'" ('+columns.join(", ")+')';
}
async function exec(tx:any,query:string) {return tx.execute(sql.raw(query))}
async function count(tx:any,query:string,n:number){
 const r=await exec(tx,query);
 assert.equal(Number(r.rows[0].n),n,query.slice(0,95));
}
async function main(){
 let rollback=false;
 try{
 await db.transaction(async (tx)=>{
  const identity=await exec(tx,"SELECT current_user::text role,current_database()::text db");
  assert.equal(identity.rows[0].role,"postgres");
  assert.equal(identity.rows[0].db,"cst_pr81_writer_ci");
  for(const type of [
   "CREATE TYPE mkt_po_status AS ENUM ('pending','confirmed','in_progress','delivered','completed','cancelled','issued','vendor_accepted','revision_requested','vendor_rejected','production','ready_to_ship','in_transit','partially_delivered','closed','rejected_goods')",
   "CREATE TYPE vi_status AS ENUM ('draft','submitted','posted','matched','ready_for_ap','paid','cancelled')",
   "CREATE TYPE pay_req_status AS ENUM ('draft','submitted','approved','rejected','paid','cancelled')",
   "CREATE TYPE mkt_ap_preparation_status AS ENUM ('ap_preparation','finance_review','waiting_payment')"
  ])await exec(tx,type);
  for(const table of tables)await exec(tx,ddl(table));
  await exec(tx,"CREATE TABLE public.accounting_entries(id serial PRIMARY KEY,company_id int NOT NULL)");
  for(const s of [
   "CREATE UNIQUE INDEX qa_ap_vi_unique ON public.mkt_ap_preparations(vendor_invoice_id)",
   "CREATE UNIQUE INDEX qa_payment_ap_unique ON public.payment_requests(mkt_ap_preparation_id)",
   "CREATE UNIQUE INDEX qa_payment_key_unique ON public.payment_requests(idempotency_key)",
   "CREATE UNIQUE INDEX qa_handoff_ap_unique ON public.mkt_accounting_handoffs(ap_preparation_id)",
   "CREATE UNIQUE INDEX qa_handoff_key_unique ON public.mkt_accounting_handoffs(handoff_key)",
   "CREATE UNIQUE INDEX qa_handoff_corr_unique ON public.mkt_accounting_handoffs(correlation_reference)",
   "ALTER TABLE public.payment_requests ADD CONSTRAINT qa_draft_only CHECK(status='draft' AND paid_amount=0 AND journal_entry_id IS NULL)",
   "ALTER TABLE public.mkt_accounting_handoffs ADD CONSTRAINT qa_handoff_draft CHECK(status='accepted' AND accounting_status='draft_not_posted')"
  ])await exec(tx,s);
  for(const stmt of [
   "INSERT INTO public.mkt_purchase_orders(id,po_number,rfq_id,quote_id,company_id,vendor_id,status,total_amount,tax_amount,grand_total) VALUES(11,'QA-PO',1,1,1,10,'confirmed',100,0,100),(31,'QA-DIVA',3,3,3,35,'confirmed',100,0,100)",
   "INSERT INTO public.mkt_po_shipments(id,po_id,shipment_number,shipment_status) VALUES(12,11,'QA-SH','delivered'),(32,31,'QA-DIVA-SH','delivered')",
   "INSERT INTO public.mkt_po_goods_receipts(id,shipment_id,receipt_number,receipt_type,inspection_status) VALUES(13,12,'QA-GR','full','passed'),(33,32,'QA-DIVA-GR','full','passed')",
   "INSERT INTO public.vendor_invoices(id,invoice_number,vendor_invoice_ref,company_id,supplier_id,supplier_name,mkt_purchase_order_id,mkt_goods_receipt_id,status,currency,total_amount,tax_amount,grand_total,three_way_match_status) VALUES(14,'QA-VI','QA-VREF',1,10,'Synthetic Supplier',11,13,'ready_for_ap','IDR',100,0,100,'passed'),(34,'QA-DIVA-VI','QA-DIVA-VREF',3,35,'Synthetic Supplier',31,33,'ready_for_ap','IDR',100,0,100,'passed')"
  ])await exec(tx,stmt);
  await exec(tx,"ALTER SEQUENCE public.mkt_ap_preparations_id_seq RESTART WITH 88");
  await exec(tx,"CREATE ROLE "+writer+" NOLOGIN NOINHERIT NOBYPASSRLS");
  await exec(tx,"GRANT "+writer+" TO postgres WITH SET TRUE");
  await exec(tx,"GRANT USAGE ON SCHEMA public TO "+writer);
  for(const table of tables){
   const name=tableName(table);
   await exec(tx,"GRANT SELECT ON public."+name+" TO "+writer);
   await exec(tx,"ALTER TABLE public."+name+" ENABLE ROW LEVEL SECURITY");
  }
  await exec(tx,"GRANT INSERT,UPDATE ON public.mkt_ap_preparations TO "+writer);
  // Canonical SELECT ... FOR UPDATE on invoice requires UPDATE privileges.
  await exec(tx,"GRANT UPDATE ON public.vendor_invoices TO "+writer);
  await exec(tx,"GRANT INSERT ON public.payment_requests,public.mkt_accounting_handoffs TO "+writer);
  await exec(tx,"GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "+writer);
  for(const p of [
   "CREATE POLICY qapo ON public.mkt_purchase_orders FOR SELECT TO "+writer+" USING(company_id="+tenant+")",
   "CREATE POLICY qash ON public.mkt_po_shipments FOR SELECT TO "+writer+" USING(EXISTS(SELECT 1 FROM public.mkt_purchase_orders p WHERE p.id=public.mkt_po_shipments.po_id))",
   "CREATE POLICY qagr ON public.mkt_po_goods_receipts FOR SELECT TO "+writer+" USING(EXISTS(SELECT 1 FROM public.mkt_po_shipments sh WHERE sh.id=public.mkt_po_goods_receipts.shipment_id))",
   "CREATE POLICY qavi ON public.vendor_invoices FOR SELECT TO "+writer+" USING(company_id="+tenant+" AND three_way_match_status='passed')",
   "CREATE POLICY qavi_update ON public.vendor_invoices FOR UPDATE TO "+writer+" USING(company_id="+tenant+") WITH CHECK(company_id="+tenant+")",
   "CREATE POLICY qaap ON public.mkt_ap_preparations FOR SELECT TO "+writer+" USING(company_id="+tenant+")",
   "CREATE POLICY qaapi ON public.mkt_ap_preparations FOR INSERT TO "+writer+" WITH CHECK(company_id="+tenant+" AND status='ap_preparation' AND EXISTS(SELECT 1 FROM public.vendor_invoices vi WHERE vi.id=vendor_invoice_id AND vi.company_id=public.mkt_ap_preparations.company_id AND vi.supplier_id=public.mkt_ap_preparations.supplier_id AND vi.status='ready_for_ap' AND vi.three_way_match_status='passed'))",
   "CREATE POLICY qaapu ON public.mkt_ap_preparations FOR UPDATE TO "+writer+" USING(company_id="+tenant+") WITH CHECK(company_id="+tenant+")",
   "CREATE POLICY qapay ON public.payment_requests FOR SELECT TO "+writer+" USING(company_id="+tenant+")",
   "CREATE POLICY qapayi ON public.payment_requests FOR INSERT TO "+writer+" WITH CHECK(company_id="+tenant+" AND status='draft' AND paid_amount=0 AND journal_entry_id IS NULL AND EXISTS(SELECT 1 FROM public.mkt_ap_preparations ap WHERE ap.id=mkt_ap_preparation_id AND ap.company_id=public.payment_requests.company_id AND ap.status='waiting_payment'))",
   "CREATE POLICY qahand ON public.mkt_accounting_handoffs FOR SELECT TO "+writer+" USING(company_id="+tenant+")",
   "CREATE POLICY qahandi ON public.mkt_accounting_handoffs FOR INSERT TO "+writer+" WITH CHECK(company_id="+tenant+" AND status='accepted' AND accounting_status='draft_not_posted' AND EXISTS(SELECT 1 FROM public.mkt_ap_preparations ap WHERE ap.id=ap_preparation_id AND ap.company_id=public.mkt_accounting_handoffs.company_id AND ap.status='waiting_payment') AND EXISTS(SELECT 1 FROM public.payment_requests p WHERE p.id=payment_request_id AND p.company_id=public.mkt_accounting_handoffs.company_id AND p.status='draft' AND p.journal_entry_id IS NULL))"
  ])await exec(tx,p);
  await exec(tx,"SET LOCAL ROLE "+writer);
  await exec(tx,"SELECT set_config('app.marketplace_company_id','1',true)");
  const who=await exec(tx,"SELECT current_user::text role,row_security_active('public.mkt_ap_preparations'::regclass) rls,has_table_privilege(current_user,'public.accounting_entries','INSERT') gl");
  assert.equal(who.rows[0].role,writer);
  assert.equal(who.rows[0].rls,true);
  assert.equal(who.rows[0].gl,false);
  console.log("ACTUAL_SERVICE_RESTRICTED_DB_ROLE_AND_RLS_PASS");
  const actor={actorId:"pr81-test",actorName:"PR81 test"};
  const created=await createApPreparation(14,actor,tx as unknown as typeof db);
  assert.equal(created.ok,true);
  if(!created.ok)throw new Error("ACTUAL_CREATE_AP_FAILED");
  assert.equal(created.alreadyExists,false);
  assert.equal(created.preparation.id,88);
  const existing=await createApPreparation(14,actor,tx as unknown as typeof db);
  assert.equal(existing.ok,true);
  if(!existing.ok)throw new Error("ACTUAL_REPLAY_AP_FAILED");
  assert.equal(existing.alreadyExists,true);
  assert.equal(existing.preparation.id,88);
  console.log("ACTUAL_SERVICE_CREATE_AP_AND_IDEMPOTENT_REPLAY_PASS");
  const earlier=await createMarketplaceAccountingHandoff(88,actor,tx as unknown as typeof db);
  assert.deepEqual(earlier,{ok:false,code:"INVALID_STATUS"});
  const reviewed=await reviewApPreparation(88,actor,tx as unknown as typeof db);
  assert.equal(reviewed.ok,true);
  const reviewedAgain=await reviewApPreparation(88,actor,tx as unknown as typeof db);
  assert.equal(reviewedAgain.ok,true);
  if(!reviewedAgain.ok)throw new Error("REVIEW_REPLAY_FAILED");
  assert.equal(reviewedAgain.alreadyExists,true);
  const waiting=await markApPreparationWaitingPayment(88,actor,tx as unknown as typeof db);
  assert.equal(waiting.ok,true);
  const waitingAgain=await markApPreparationWaitingPayment(88,actor,tx as unknown as typeof db);
  assert.equal(waitingAgain.ok,true);
  if(!waitingAgain.ok)throw new Error("WAITING_REPLAY_FAILED");
  assert.equal(waitingAgain.alreadyExists,true);
  console.log("ACTUAL_SERVICE_AP_WAITING_PAYMENT_REPLAY_PASS");
  const first=await createMarketplaceAccountingHandoff(88,actor,tx as unknown as typeof db);
  assert.equal(first.ok,true);
  if(!first.ok)throw new Error("HANDOFF_FAILED");
  assert.equal(first.alreadyExists,false);
  const replay=await createMarketplaceAccountingHandoff(88,actor,tx as unknown as typeof db);
  assert.equal(replay.ok,true);
  if(!replay.ok)throw new Error("HANDOFF_REPLAY_FAILED");
  assert.equal(replay.alreadyExists,true);
  assert.equal(first.paymentRequestId,replay.paymentRequestId);
  assert.equal(first.handoffId,replay.handoffId);
  await count(tx,"SELECT count(*)::int n FROM public.mkt_ap_preparations WHERE id=88 AND status='waiting_payment'",1);
  await count(tx,"SELECT count(*)::int n FROM public.payment_requests WHERE mkt_ap_preparation_id=88 AND status='draft' AND paid_amount=0 AND journal_entry_id IS NULL",1);
  await count(tx,"SELECT count(*)::int n FROM public.mkt_accounting_handoffs WHERE ap_preparation_id=88 AND status='accepted' AND accounting_status='draft_not_posted'",1);
  await count(tx,"SELECT count(*)::int n FROM public.payment_requests",1);
  await count(tx,"SELECT count(*)::int n FROM public.mkt_accounting_handoffs",1);
  // Role has no GL SELECT/INSERT; assert privilege denial, not row count.
  console.log("ACTUAL_SERVICE_ONE_DRAFT_PAYMENT_HANDOFF_IDEMPOTENT_PASS");
  await exec(tx,"SELECT set_config('app.marketplace_company_id','3',true)");
  assert.equal(await getApPreparation(88,tx as unknown as typeof db),null);
  assert.deepEqual(await createMarketplaceAccountingHandoff(88,actor,tx as unknown as typeof db),{ok:false,code:"NOT_FOUND"});
  await count(tx,"SELECT count(*)::int n FROM public.payment_requests",0);
  await count(tx,"SELECT count(*)::int n FROM public.mkt_accounting_handoffs",0);
  console.log("ACTUAL_SERVICE_DIVA_CANNOT_READ_CST_HANDOFF_PASS");
  assert(afterCommitActions.length>=2);
  console.log("EXTERNAL_AUDIT_NOTIFICATIONS_NEVER_PUBLISHED=true");
  throw new RollbackComplete("ROLLBACK_ALL_ACTUAL_SERVICE_TEST_WRITES");
 });
 }catch(e){
  if(!(e instanceof RollbackComplete))throw e;
  rollback=true;
 }
 assert(rollback);
 const post=await db.execute(sql.raw("SELECT to_regclass('public.mkt_ap_preparations') ap,to_regclass('public.payment_requests') payment,to_regclass('public.mkt_accounting_handoffs') handoff,(SELECT count(*)::int FROM pg_roles WHERE rolname='ci_pr81_real_writer') roles"));
 assert.equal(post.rows[0].ap,null);
 assert.equal(post.rows[0].payment,null);
 assert.equal(post.rows[0].handoff,null);
 assert.equal(Number(post.rows[0].roles),0);
 console.log("ACTUAL_SERVICE_POST_ROLLBACK_NO_TABLES_ROLES_OR_ROWS_PASS");
}
main().then(async()=>{
 await pool.end();
 console.log("PR81_ACTUAL_SERVICE_TO_DISPOSABLE_POSTGRES_PASS");
}).catch(async(err)=>{
 console.error("PR81_ACTUAL_SERVICE_TEST_FAILED",err instanceof Error?err.message:"unknown");
 const cause=(err instanceof Error && "cause" in err)?(err as {cause?:{code?:string}}).cause:undefined;
 if(cause?.code)console.error("POSTGRES_ERROR_CODE",cause.code);
 try{await pool.end()}catch{}
 process.exitCode=1;
});
