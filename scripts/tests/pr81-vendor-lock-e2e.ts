/** Negative permission proof for the UNMODIFIED canonical Vendor Invoice service.
 * Synthetic PostgreSQL 16 only; all DDL, role and data are rolled back.
 * No external DB, storage, activity log, notification, or HTTP endpoint.
 */
import assert from "node:assert/strict";
import {sql,getTableColumns} from "drizzle-orm";
import {db,pool,mktPurchaseOrdersTable,mktPoGoodsReceiptsTable,vendorInvoicesTable} from "./pr81-vendor-lock-db-stub";
import {createMarketplaceVendorInvoice} from "../../artifacts/api-server/src/lib/services/mktVendorInvoiceService";
const role="ci_pr81_vendor_lock";
const tenant="nullif(current_setting('app.marketplace_company_id',true),'')::int";
const allowed=new Set(["mkt_purchase_orders","mkt_po_goods_receipts","vendor_invoices"]);
class RollbackComplete extends Error {}
function ddl(table:any):string {
 const name=table[Symbol.for("drizzle:Name")];
 assert(allowed.has(name),name);
 const columns=Object.values(getTableColumns(table)).map((col:any)=>{
  const type=col.getSQLType();
  assert(/^(serial|integer|text|timestamp|date|boolean|jsonb|numeric\(\d+, \d+\)|mkt_po_status|vi_status|pay_req_status|mkt_ap_preparation_status)$/.test(type),type);
  let definition='"'+col.name+'" '+type;
  if(type==="serial") return definition+" PRIMARY KEY";
  if(col.notNull) definition+=" NOT NULL";
  if(col.hasDefault){
   if(col.dataType==="date") definition+=" DEFAULT now()";
   else if(typeof col.default==="string") definition+=" DEFAULT '"+col.default.replaceAll("'","''")+"'";
   else if(typeof col.default==="number"||typeof col.default==="boolean") definition+=" DEFAULT "+String(col.default);
   else throw Error("Unknown SQL default for "+name+"."+col.name);
  }
  return definition;
 });
 return 'CREATE TABLE public."'+name+'" ('+columns.join(", ")+')';
}
async function exec(tx:any,q:string){return tx.execute(sql.raw(q))}
function pgCode(e:unknown):string|undefined {
 let x:any=e;
 for(let i=0;i<6 && x;i++,x=x.cause)if(typeof x.code==="string")return x.code;
 return undefined;
}
const input={
 poId:11,grId:13,vendorInvoiceRef:"DISPOSABLE-LOCK-CHECK",
 invoiceDate:new Date("2026-11-16T00:00:00Z"),currency:"IDR",
 totalAmount:100,taxAmount:0,grandTotal:100,
 supplierId:10,supplierName:"Synthetic Supplier",companyId:1,createdBy:"ci-test",
 lines:[{poLineId:21,quantity:1,unitPrice:100,subtotal:100}],
 attachment:{objectPath:"synthetic-only/not-uploaded.pdf",fileName:"test.pdf",contentType:"application/pdf",size:10},
};
const actor={actorType:"vendor" as const,actorId:"10",actorName:"Synthetic Vendor"};
async function expectPermissionDenied(tx:any,label:string,table:string){
 let error:unknown;
 try{await createMarketplaceVendorInvoice(input,actor,tx as any)}catch(e){error=e}
 assert(error instanceof Error,label+" expected actual service failure, got success");
 assert.equal(pgCode(error),"42501",label+": expected PostgreSQL permission_denied");
 let cause:any=error;
 for(let i=0;i<6 && cause && cause.code!=="42501";i++)cause=cause.cause;
 assert.match(String(cause?.message),new RegExp("permission denied for table "+table),label+": must identify the locked table");
 console.log(label+"_EXPECTED_42501_PASS");
}
async function main(){
 let rollback=false;
 try {
 await db.transaction(async tx=>{
  const id=await exec(tx,"SELECT current_user::text role,current_database()::text db");
  assert.equal(id.rows[0].role,"postgres");
  assert.equal(id.rows[0].db,"cst_pr81_writer_ci");
  await exec(tx,"CREATE TYPE mkt_po_status AS ENUM ('pending','confirmed','cancelled')");
  await exec(tx,"CREATE TYPE vi_status AS ENUM ('draft','submitted','posted','matched','ready_for_ap','paid','cancelled')");
  for(const table of [mktPurchaseOrdersTable,mktPoGoodsReceiptsTable,vendorInvoicesTable])await exec(tx,ddl(table));
  await exec(tx,"INSERT INTO public.mkt_purchase_orders(id,po_number,rfq_id,quote_id,company_id,vendor_id,status,total_amount,tax_amount,grand_total) VALUES(11,'DISPOSABLE-PO',1,1,1,10,'confirmed',100,0,100)");
  await exec(tx,"INSERT INTO public.mkt_po_goods_receipts(id,shipment_id,receipt_number,receipt_type,inspection_status) VALUES(13,12,'DISPOSABLE-GR','full','passed')");
  await exec(tx,"CREATE ROLE "+role+" NOLOGIN NOINHERIT NOBYPASSRLS");
  await exec(tx,"GRANT "+role+" TO postgres WITH SET TRUE");
  await exec(tx,"GRANT USAGE ON SCHEMA public TO "+role);
  for(const name of allowed){
   await exec(tx,"GRANT SELECT ON public."+name+" TO "+role);
   await exec(tx,"ALTER TABLE public."+name+" ENABLE ROW LEVEL SECURITY");
  }
  await exec(tx,"CREATE POLICY qa_po_select ON public.mkt_purchase_orders FOR SELECT TO "+role+" USING(company_id="+tenant+")");
  await exec(tx,"CREATE POLICY qa_gr_select ON public.mkt_po_goods_receipts FOR SELECT TO "+role+" USING(true)");
  await exec(tx,"CREATE POLICY qa_vi_select ON public.vendor_invoices FOR SELECT TO "+role+" USING(company_id="+tenant+")");
  await exec(tx,"SET LOCAL ROLE "+role);
  await exec(tx,"SELECT set_config('app.marketplace_company_id','1',true)");
  const privilege=await exec(tx,"SELECT current_user::text role,has_table_privilege(current_user,'public.mkt_purchase_orders','UPDATE') po_update,has_any_column_privilege(current_user,'public.mkt_purchase_orders','UPDATE') po_col_update,has_any_column_privilege(current_user,'public.mkt_po_goods_receipts','UPDATE') gr_col_update");
  assert.equal(privilege.rows[0].role,role);
  assert.equal(privilege.rows[0].po_update,false);
  assert.equal(privilege.rows[0].po_col_update,false);
  assert.equal(privilege.rows[0].gr_col_update,false);
  await expectPermissionDenied(tx,"CANONICAL_VENDOR_INVOICE_PO_LOCK","mkt_purchase_orders");
  await exec(tx,"RESET ROLE");
  // Hypothetical disposable-only column grant isolates the second blocker.
  // Never apply this GRANT to the live Finance role or CST-DEV.
  await exec(tx,"GRANT UPDATE(status) ON public.mkt_purchase_orders TO "+role);
  await exec(tx,"CREATE POLICY qa_po_update ON public.mkt_purchase_orders FOR UPDATE TO "+role+" USING(company_id="+tenant+") WITH CHECK(company_id="+tenant+")");
  await exec(tx,"SET LOCAL ROLE "+role);
  const po=await exec(tx,"SELECT has_any_column_privilege(current_user,'public.mkt_purchase_orders','UPDATE') po_col_update,has_any_column_privilege(current_user,'public.mkt_po_goods_receipts','UPDATE') gr_col_update");
  assert.equal(po.rows[0].po_col_update,true);
  assert.equal(po.rows[0].gr_col_update,false);
  await expectPermissionDenied(tx,"CANONICAL_VENDOR_INVOICE_GR_LOCK","mkt_po_goods_receipts");
  const rows=await exec(tx,"SELECT count(*)::int n FROM public.vendor_invoices");
  assert.equal(Number(rows.rows[0].n),0);
  console.log("NO_INVOICE_INSERTED_PASS");
  throw new RollbackComplete("ROLLBACK_ALL_VENDOR_LOCK_PROOF");
 });
 }catch(e){if(!(e instanceof RollbackComplete))throw e;rollback=true}
 assert(rollback);
 const check=await db.execute(sql.raw("SELECT to_regclass('public.mkt_purchase_orders') po,to_regclass('public.mkt_po_goods_receipts') gr,to_regclass('public.vendor_invoices') vi,(SELECT count(*)::int FROM pg_roles WHERE rolname='ci_pr81_vendor_lock') roles"));
 assert.equal(check.rows[0].po,null);assert.equal(check.rows[0].gr,null);
 assert.equal(check.rows[0].vi,null);assert.equal(Number(check.rows[0].roles),0);
 console.log("ROLE_SCHEMA_AND_FIXTURES_ROLLED_BACK_PASS");
}
main().then(async()=>{await pool.end();console.log("PR81_VENDOR_LOCK_PERMISSION_NEGATIVE_E2E_PASS")})
 .catch(async(e)=>{console.error("PR81_VENDOR_LOCK_TEST_FAILED",e instanceof Error?e.message:e);console.error("POSTGRES_ERROR_CODE",pgCode(e));try{await pool.end()}catch{};process.exitCode=1});
