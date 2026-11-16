/** Positive authorization rehearsal: unchanged Vendor Invoice business validation
 * plus the Draft PR102 opt-in DB row-lock adapter on disposable PG16 only.
 * All DDL, roles, fixtures, invoices & function are inside outer rollback.
 */
import assert from "node:assert/strict";
import {sql,getTableColumns} from "drizzle-orm";
import {
 db,pool,afterCommitActions,
 mktPurchaseOrdersTable,mktPoGoodsReceiptsTable,mktPoShipmentsTable,
 mktPoGoodsReceiptItemsTable,mktPoShipmentItemsTable,mktPurchaseOrderLinesTable,
 vendorInvoicesTable,vendorInvoiceLinesTable,
} from "./pr81-vendor-lock-db-stub";
import {vendorParentLockFunctionSql} from "./pr102-vendor-parent-lock-function";
import {createMarketplaceVendorInvoice} from "../../artifacts/api-server/src/lib/services/mktVendorInvoiceService";
const finance="ci_pr102_vendor_finance";
const owner="ci_pr102_parent_lock_owner";
const stranger="ci_pr102_stranger";
const tenant="nullif(current_setting('app.marketplace_company_id',true),'')::int";
const tables=[
 mktPurchaseOrdersTable,mktPoShipmentsTable,mktPoGoodsReceiptsTable,
 mktPurchaseOrderLinesTable,mktPoShipmentItemsTable,mktPoGoodsReceiptItemsTable,
 vendorInvoicesTable,vendorInvoiceLinesTable
];
const allowed=new Set(["mkt_purchase_orders","mkt_po_shipments","mkt_po_goods_receipts",
 "mkt_purchase_order_lines","mkt_po_shipment_items","mkt_po_goods_receipt_items",
 "vendor_invoices","vendor_invoice_lines"]);
class RollbackDone extends Error {}
function tableName(t:any):string {
 const n=t[Symbol.for("drizzle:Name")];
 assert(allowed.has(n),String(n)); return n;
}
function ddl(table:any):string {
 const name=tableName(table);
 const columns=Object.values(getTableColumns(table)).map((c:any)=>{
  const type=c.getSQLType();
  assert(/^(serial|integer|text|timestamp|date|boolean|jsonb|numeric\(\d+, \d+\)|mkt_po_status|vi_status)$/.test(type),type);
  let q='"'+c.name+'" '+type;
  if(type==="serial")return q+" PRIMARY KEY";
  if(c.notNull)q+=" NOT NULL";
  if(c.hasDefault){
   if(c.dataType==="date")q+=" DEFAULT now()";
   else if(typeof c.default==="string")q+=" DEFAULT '"+c.default.replaceAll("'","''")+"'";
   else if(typeof c.default==="number"||typeof c.default==="boolean")q+=" DEFAULT "+String(c.default);
   else throw Error("unsupported default "+name+"."+c.name);
  }
  return q;
 });
 return 'CREATE TABLE public."'+name+'" ('+columns.join(", ")+')';
}
async function exec(tx:any, q:string){return tx.execute(sql.raw(q))}
function pgCode(e:unknown){
 let cause:any=e;
 for(let i=0;i<8&&cause;i++,cause=cause.cause)if(typeof cause.code==="string")return cause.code;
 return "";
}
const actor={actorType:"vendor" as const,actorId:"10",actorName:"Synthetic Vendor"};
function invoice(poId:number,grId:number,supplierId:number,poLineId:number,companyId:number,ref:string){
 return {
  poId,grId,supplierId,companyId,poLineId,createdBy:"synthetic-only",
  vendorToken:companyId===1?"a".repeat(64):"b".repeat(64),
  vendorInvoiceRef:ref,invoiceDate:new Date("2026-11-16T00:00:00Z"),currency:"IDR",
  totalAmount:100,taxAmount:0,grandTotal:100,supplierName:"Synthetic Supplier",
  lines:[{poLineId,quantity:1,unitPrice:100,subtotal:100,name:"Synthetic Item"}],
  attachment:{objectPath:"synthetic-only/never-uploaded.pdf",fileName:"proof.pdf",contentType:"application/pdf",size:10},
 };
}
function parentPolicy(table:string){
 if(table==="mkt_purchase_orders")return "company_id="+tenant;
 if(table==="mkt_po_goods_receipts")return "EXISTS (SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders p ON p.id=sh.po_id WHERE sh.id=shipment_id AND p.company_id="+tenant+")";
 throw Error(table);
}
async function main(){
 process.env.APP_ENV="development";
 process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV="true";
 process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV="true";
 let rolled=false;
 try {
 await db.transaction(async tx=>{
  const id=await exec(tx,"SELECT current_user::text role,current_database()::text db");
  assert.equal(id.rows[0].role,"postgres");
  assert.equal(id.rows[0].db,"cst_pr81_writer_ci");
  await exec(tx,"CREATE TYPE mkt_po_status AS ENUM ('pending','confirmed','cancelled')");
  await exec(tx,"CREATE TYPE vi_status AS ENUM ('draft','submitted','posted','matched','ready_for_ap','paid','cancelled')");
  for(const table of tables)await exec(tx,ddl(table));
  await exec(tx,"CREATE UNIQUE INDEX ci_pr102_invoice_dedup ON public.vendor_invoices(supplier_id,vendor_invoice_ref,mkt_purchase_order_id)");
  await exec(tx,"INSERT INTO public.mkt_purchase_orders(id,po_number,rfq_id,quote_id,company_id,vendor_id,status,total_amount,tax_amount,grand_total,vendor_token) VALUES (11,'CI-CST-PO',1,1,1,10,'confirmed',100,0,100,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),(31,'CI-DIVA-PO',3,3,3,35,'confirmed',100,0,100,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')");
  await exec(tx,"INSERT INTO public.mkt_po_shipments(id,po_id,shipment_number,shipment_status) VALUES (12,11,'CI-CST-SHIP','delivered'),(32,31,'CI-DIVA-SHIP','delivered')");
  await exec(tx,"INSERT INTO public.mkt_po_goods_receipts(id,shipment_id,receipt_number,receipt_type,inspection_status) VALUES (13,12,'CI-CST-GR','full','passed'),(33,32,'CI-DIVA-GR','full','passed')");
  await exec(tx,"INSERT INTO public.mkt_purchase_order_lines(id,po_id,item_name,qty,unit_price,subtotal) VALUES (21,11,'CI-CST-ITEM',1,100,100),(41,31,'CI-DIVA-ITEM',1,100,100)");
  await exec(tx,"INSERT INTO public.mkt_po_shipment_items(id,shipment_id,po_line_id,line_number,qty) VALUES (22,12,21,1,1),(42,32,41,1,1)");
  await exec(tx,"INSERT INTO public.mkt_po_goods_receipt_items(id,goods_receipt_id,shipment_item_id,received_qty,accepted_qty,rejected_qty) VALUES (23,13,22,1,1,0),(43,33,42,1,1,0)");
  await exec(tx,"CREATE ROLE "+finance+" NOLOGIN NOINHERIT NOBYPASSRLS");
  await exec(tx,"CREATE ROLE "+owner+" NOLOGIN NOINHERIT NOBYPASSRLS");
  await exec(tx,"CREATE ROLE "+stranger+" NOLOGIN NOINHERIT NOBYPASSRLS");
  await exec(tx,"GRANT "+finance+", "+owner+", "+stranger+" TO postgres WITH SET TRUE");
  await exec(tx,"GRANT USAGE ON SCHEMA public TO "+finance+","+owner+","+stranger);
  for(const table of tables)await exec(tx,"ALTER TABLE public."+tableName(table)+" ENABLE ROW LEVEL SECURITY");
  for(const table of tables)await exec(tx,"GRANT SELECT ON public."+tableName(table)+" TO "+finance);
  await exec(tx,"GRANT INSERT ON public.vendor_invoices, public.vendor_invoice_lines TO "+finance);
  await exec(tx,"GRANT USAGE ON SEQUENCE public.vendor_invoices_id_seq,public.vendor_invoice_lines_id_seq TO "+finance);
  for(const [name,guard] of [
   ["mkt_purchase_orders","company_id="+tenant],
   ["mkt_po_shipments","EXISTS(SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=po_id)"],
   ["mkt_po_goods_receipts","EXISTS(SELECT 1 FROM public.mkt_po_shipments sh WHERE sh.id=shipment_id)"],
   ["mkt_purchase_order_lines","EXISTS(SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=po_id)"],
   ["mkt_po_shipment_items","EXISTS(SELECT 1 FROM public.mkt_po_shipments sh WHERE sh.id=shipment_id)"],
   ["mkt_po_goods_receipt_items","EXISTS(SELECT 1 FROM public.mkt_po_goods_receipts gr WHERE gr.id=goods_receipt_id)"],
   ["vendor_invoices","company_id="+tenant],
   ["vendor_invoice_lines","EXISTS(SELECT 1 FROM public.vendor_invoices vi WHERE vi.id=invoice_id)"],
  ]){
   await exec(tx,"CREATE POLICY finance_select_"+name+" ON public."+name+" FOR SELECT TO "+finance+" USING("+guard+")");
  }
  await exec(tx,"CREATE POLICY finance_insert_invoice ON public.vendor_invoices FOR INSERT TO "+finance+" WITH CHECK(company_id="+tenant+" AND status='draft' AND three_way_match_status='unmatched')");
  await exec(tx,"CREATE POLICY finance_insert_lines ON public.vendor_invoice_lines FOR INSERT TO "+finance+" WITH CHECK(EXISTS(SELECT 1 FROM public.vendor_invoices vi WHERE vi.id=invoice_id AND vi.company_id="+tenant+"))");
  // The owner is NOT the table owner, has no login, no bypassrls and has
  // only one UPDATE column on each parent. The Finance login has none.
  await exec(tx,"GRANT SELECT ON public.mkt_purchase_orders,public.mkt_po_shipments,public.mkt_po_goods_receipts TO "+owner);
  await exec(tx,"GRANT UPDATE(status) ON public.mkt_purchase_orders TO "+owner);
  await exec(tx,"GRANT UPDATE(inspection_status) ON public.mkt_po_goods_receipts TO "+owner);
  await exec(tx,"GRANT UPDATE(shipment_status) ON public.mkt_po_shipments TO "+owner);
  for(const name of ["mkt_purchase_orders","mkt_po_goods_receipts"]){
   const guard=parentPolicy(name);
   await exec(tx,"CREATE POLICY owner_select_"+name+" ON public."+name+" FOR SELECT TO "+owner+" USING("+guard+")");
   await exec(tx,"CREATE POLICY owner_update_"+name+" ON public."+name+" FOR UPDATE TO "+owner+" USING("+guard+") WITH CHECK("+guard+")");
  }
  await exec(tx,"CREATE POLICY owner_select_shipment ON public.mkt_po_shipments FOR SELECT TO "+owner+" USING(EXISTS(SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=po_id AND po.company_id="+tenant+"))");
  await exec(tx,"CREATE POLICY owner_update_shipment ON public.mkt_po_shipments FOR UPDATE TO "+owner+" USING(EXISTS(SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=po_id AND po.company_id="+tenant+")) WITH CHECK(EXISTS(SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=po_id AND po.company_id="+tenant+"))");
  // Private schema not exposed through Supabase/PostgREST. Only the Finance
  // login can USAGE + EXECUTE the definer; owner has no login or BYPASSRLS.
  await exec(tx,"CREATE SCHEMA finance_ops_private AUTHORIZATION postgres");
  await exec(tx,"REVOKE ALL ON SCHEMA finance_ops_private FROM PUBLIC");
  await exec(tx,"GRANT USAGE ON SCHEMA finance_ops_private TO "+finance+","+owner);
  await exec(tx,"GRANT CREATE ON SCHEMA finance_ops_private TO "+owner);
  await exec(tx,vendorParentLockFunctionSql);
  await exec(tx,"REVOKE ALL ON FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) FROM PUBLIC");
  await exec(tx,"ALTER FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) OWNER TO "+owner);
  await exec(tx,"REVOKE CREATE ON SCHEMA finance_ops_private FROM "+owner);
  await exec(tx,"GRANT EXECUTE ON FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) TO "+finance);
  const privateOnly=await exec(tx,"SELECT to_regprocedure('public.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') AS public_fn");
  assert.equal(privateOnly.rows[0].public_fn,null);
  const outsider=await exec(tx,"SELECT has_schema_privilege('"+stranger+"','finance_ops_private','USAGE') AS schema_usage,has_function_privilege('"+stranger+"','finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE') AS may_execute");
  assert.equal(outsider.rows[0].schema_usage,false);
  assert.equal(outsider.rows[0].may_execute,false);
  console.log("PRIVATE_SCHEMA_DENIES_OUTSIDER_EXECUTE_PASS");
  await exec(tx,"SET LOCAL ROLE "+finance);
  await exec(tx,"SELECT set_config('app.marketplace_company_id','1',true)");
  const check=await exec(tx,"SELECT current_user::text role,has_any_column_privilege(current_user,'public.mkt_purchase_orders','UPDATE') po_update,has_any_column_privilege(current_user,'public.mkt_po_goods_receipts','UPDATE') gr_update,has_any_column_privilege(current_user,'public.mkt_po_shipments','UPDATE') shipment_update,has_function_privilege(current_user,'finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)','EXECUTE') may_lock");
  assert.equal(check.rows[0].role,finance);
  assert.equal(check.rows[0].po_update,false);
  assert.equal(check.rows[0].gr_update,false);
  assert.equal(check.rows[0].shipment_update,false);
  assert.equal(check.rows[0].may_lock,true);
  console.log("FINANCE_NO_PO_GR_SHIPMENT_UPDATE_PRIVILEGE_PASS");
  const cst=invoice(11,13,10,21,1,"CI-CST-VENDOR-001");
  const first=await createMarketplaceVendorInvoice(cst,actor,tx as unknown as typeof db);
  assert.equal(first.ok,true,JSON.stringify(first));
  if(!first.ok)throw Error("CST_CREATE_DENIED");
  assert.equal(first.alreadyExists,false);
  assert.equal(first.invoice.companyId,1);
  assert.equal(first.lines.length,1);
  console.log("CANONICAL_VENDOR_INVOICE_SCOPED_LOCK_CREATE_PASS");
  const replay=await createMarketplaceVendorInvoice(cst,actor,tx as unknown as typeof db);
  assert.equal(replay.ok,true);
  if(!replay.ok)throw Error("CST_REPLAY_DENIED");
  assert.equal(replay.alreadyExists,true);
  assert.equal(replay.invoice.id,first.invoice.id);
  const one=await exec(tx,"SELECT count(*)::integer n FROM public.vendor_invoices");
  assert.equal(Number(one.rows[0].n),1);
  console.log("CANONICAL_VENDOR_INVOICE_IDEMPOTENT_REPLAY_PASS");
  // Simulated token rotation between route revalidation and row locking.
  await exec(tx,"RESET ROLE");
  await exec(tx,"UPDATE public.mkt_purchase_orders SET vendor_token='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' WHERE id=11");
  await exec(tx,"SET LOCAL ROLE "+finance);
  const rotated=await createMarketplaceVendorInvoice(cst,actor,tx as unknown as typeof db);
  assert.deepEqual(rotated,{ok:false,code:"PO_NOT_FOUND"});
  console.log("ROTATED_VENDOR_TOKEN_REVALIDATION_UNDER_PO_LOCK_PASS");
  await exec(tx,"RESET ROLE");
  await exec(tx,"UPDATE public.mkt_purchase_orders SET vendor_token='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', vendor_token_expires_at=(now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id=11");
  await exec(tx,"SET LOCAL ROLE "+finance);
  const expired=await createMarketplaceVendorInvoice(cst,actor,tx as unknown as typeof db);
  assert.deepEqual(expired,{ok:false,code:"PO_NOT_FOUND"});
  console.log("EXPIRED_VENDOR_TOKEN_REJECTED_UNDER_PO_LOCK_PASS");
  await exec(tx,"SELECT set_config('app.marketplace_company_id','3',true)");
  const denied=await createMarketplaceVendorInvoice(cst,actor,tx as unknown as typeof db);
  assert.deepEqual(denied,{ok:false,code:"PO_NOT_FOUND"});
  const hidden=await exec(tx,"SELECT count(*)::integer n FROM public.vendor_invoices");
  assert.equal(Number(hidden.rows[0].n),0);
  console.log("CANONICAL_CST_INVOICE_HIDDEN_FROM_DIVA_PASS");
  const diva=invoice(31,33,35,41,3,"CI-DIVA-VENDOR-001");
  const own=await createMarketplaceVendorInvoice(diva,actor,tx as unknown as typeof db);
  assert.equal(own.ok,true,JSON.stringify(own));
  if(!own.ok)throw Error("DIVA_CREATE_DENIED");
  assert.equal(own.invoice.companyId,3);
  const divaRows=await exec(tx,"SELECT count(*)::integer n FROM public.vendor_invoices");
  assert.equal(Number(divaRows.rows[0].n),1);
  console.log("CANONICAL_DIVA_ISOLATED_INVOICE_CREATE_PASS");
  // When opt-in is OFF, canonical FOR UPDATE refuses the direct Finance role.
  process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV="false";
  let fallbackError:unknown;
  try{await createMarketplaceVendorInvoice(diva,actor,tx as unknown as typeof db)}catch(e){fallbackError=e}
  assert.equal(pgCode(fallbackError),"42501","No unlocked Finance fallback when new flag OFF");
  process.env.BIZPORTAL_MARKETPLACE_VENDOR_PARENT_LOCK_ENABLED_DEV="true";
  console.log("FINANCE_PARENT_LOCK_OPT_IN_DISABLED_FAIL_CLOSED_PASS");
  // Unrelated DB role may not execute the definer routine.
  await exec(tx,"SET LOCAL ROLE "+stranger);
  let privilegeError:unknown;
  try{await tx.transaction(async(inner:any)=>{await exec(inner,"SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')")})}catch(e){privilegeError=e}
  assert.equal(pgCode(privilegeError),"42501");
  console.log("UNAUTHORIZED_DEF_INER_EXECUTE_DENIED_PASS");
  assert(afterCommitActions.length>=2);
  console.log("NO_EXTERNAL_ACTIVITY_OR_NOTIFICATION_SENT_PASS");
  throw new RollbackDone("ROLLBACK_ALL_VENDOR_PARENT_LOCK_PROTOTYPE");
 });
 }catch(e){if(!(e instanceof RollbackDone))throw e;rolled=true}
 assert(rolled);
 const after=await db.execute(sql.raw("SELECT to_regclass('public.mkt_purchase_orders') po,to_regclass('public.mkt_po_goods_receipts') gr,to_regclass('public.vendor_invoices') vi,(SELECT count(*)::integer FROM pg_roles WHERE rolname IN ('ci_pr102_vendor_finance','ci_pr102_parent_lock_owner','ci_pr102_stranger')) roles"));
 assert.equal(after.rows[0].po,null);assert.equal(after.rows[0].gr,null);
 assert.equal(after.rows[0].vi,null);assert.equal(Number(after.rows[0].roles),0);
 const privateCheck=await db.execute(sql.raw("SELECT to_regnamespace('finance_ops_private') AS schema_name"));
 assert.equal(privateCheck.rows[0].schema_name,null);
 console.log("PARENT_LOCK_PROTOTYPE_DB_ROLLBACK_PASS");
}
main().then(async()=>{await pool.end();console.log("PR102_CANONICAL_VENDOR_INVOICE_SCOPED_DEF_INER_POSTGRES_PASS")})
 .catch(async(e)=>{console.error("PR102_VENDOR_LOCK_TEST_FAILED",e instanceof Error?e.message:e);console.error("POSTGRES_ERROR_CODE",pgCode(e));try{await pool.end()}catch{};process.exitCode=1});
