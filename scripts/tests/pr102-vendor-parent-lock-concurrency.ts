/** Verify the SAME SECURITY DEFINER row-lock routine blocks unrelated writers.
 * One internal, disposable PostgreSQL 16 database only. Never PROD/CST-DEV.
 */
import assert from "node:assert/strict";
import pg from "pg";
import {vendorParentLockFunctionSql} from "./pr102-vendor-parent-lock-function";
const raw=process.env.PR81_DISPOSABLE_PG_URL||"";
const u=new URL(raw);
if(process.env.PR81_DISPOSABLE_SERVICE_E2E!=="true"||u.hostname!=="pr81pg"||
 u.port!=="5432"||u.pathname!=="/cst_pr81_writer_ci"||u.username!=="postgres"||
 u.password!=="synthetic-only"||u.protocol!=="postgresql:"||u.search||u.hash)
 throw Error("REFUSE_NON_DISPOSABLE_CONCURRENCY_DATABASE");
const db=new pg.Pool({connectionString:raw,max:5,ssl:false,connectionTimeoutMillis:3000,
 application_name:"pr102-parent-lock-concurrency-disposable"});
const finance="ci_pr102_concurrency_finance";
const owner="ci_pr102_concurrency_owner";
const tenant="nullif(current_setting('app.marketplace_company_id',true),'')::integer";
const q=(s:string)=>db.query(s);
async function setup(){
 const id=await q("SELECT current_database()::text db,current_user::text role");
 assert.equal(id.rows[0].db,"cst_pr81_writer_ci");
 assert.equal(id.rows[0].role,"postgres");
 await q("CREATE TABLE public.mkt_purchase_orders (id integer PRIMARY KEY,company_id integer NOT NULL,vendor_id integer NOT NULL,status text NOT NULL,vendor_token text NOT NULL,vendor_token_expires_at timestamp)");
 await q("CREATE TABLE public.mkt_po_shipments (id integer PRIMARY KEY,po_id integer NOT NULL)");
 await q("CREATE TABLE public.mkt_po_goods_receipts (id integer PRIMARY KEY,shipment_id integer NOT NULL,inspection_status text NOT NULL)");
 await q("INSERT INTO public.mkt_purchase_orders VALUES (11,1,10,'confirmed','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL),(31,3,35,'confirmed','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',NULL)");
 await q("INSERT INTO public.mkt_po_shipments VALUES (12,11),(32,31)");
 await q("INSERT INTO public.mkt_po_goods_receipts VALUES (13,12,'passed'),(33,32,'passed')");
 await q("CREATE ROLE "+finance+" NOLOGIN NOINHERIT NOBYPASSRLS");
 await q("CREATE ROLE "+owner+" NOLOGIN NOINHERIT NOBYPASSRLS");
 await q("GRANT "+finance+","+owner+" TO postgres WITH SET TRUE");
 await q("GRANT USAGE ON SCHEMA public TO "+finance+","+owner);
 for(const t of ["mkt_purchase_orders","mkt_po_shipments","mkt_po_goods_receipts"])
  await q("ALTER TABLE public."+t+" ENABLE ROW LEVEL SECURITY");
 await q("GRANT SELECT ON public.mkt_purchase_orders,public.mkt_po_shipments,public.mkt_po_goods_receipts TO "+owner);
 await q("GRANT UPDATE(status) ON public.mkt_purchase_orders TO "+owner);
 await q("GRANT UPDATE(inspection_status) ON public.mkt_po_goods_receipts TO "+owner);
 await q("CREATE POLICY owner_po_sel ON public.mkt_purchase_orders FOR SELECT TO "+owner+" USING(company_id="+tenant+")");
 await q("CREATE POLICY owner_po_upd ON public.mkt_purchase_orders FOR UPDATE TO "+owner+" USING(company_id="+tenant+") WITH CHECK(company_id="+tenant+")");
 const grScope="EXISTS(SELECT 1 FROM public.mkt_po_shipments sh JOIN public.mkt_purchase_orders po ON po.id=sh.po_id WHERE sh.id=shipment_id AND po.company_id="+tenant+")";
 await q("CREATE POLICY owner_gr_sel ON public.mkt_po_goods_receipts FOR SELECT TO "+owner+" USING("+grScope+")");
 await q("CREATE POLICY owner_gr_upd ON public.mkt_po_goods_receipts FOR UPDATE TO "+owner+" USING("+grScope+") WITH CHECK("+grScope+")");
 await q("CREATE POLICY owner_ship_sel ON public.mkt_po_shipments FOR SELECT TO "+owner+" USING(EXISTS(SELECT 1 FROM public.mkt_purchase_orders po WHERE po.id=po_id AND po.company_id="+tenant+"))");
 await q("CREATE SCHEMA finance_ops_private AUTHORIZATION postgres");
 await q("REVOKE ALL ON SCHEMA finance_ops_private FROM PUBLIC");
 await q("GRANT USAGE ON SCHEMA finance_ops_private TO "+finance+","+owner);
 await q("GRANT CREATE ON SCHEMA finance_ops_private TO "+owner);
 await q(vendorParentLockFunctionSql);
 await q("REVOKE ALL ON FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) FROM PUBLIC");
 await q("ALTER FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) OWNER TO "+owner);
 await q("REVOKE CREATE ON SCHEMA finance_ops_private FROM "+owner);
 await q("GRANT EXECUTE ON FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text) TO "+finance);
 const privateOnly=await q("SELECT to_regprocedure('public.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)') AS public_fn");
 assert.equal(privateOnly.rows[0].public_fn,null);
}
async function blockedWriter(client:pg.PoolClient,statement:string,label:string){
 await client.query("BEGIN");
 await client.query("SET LOCAL lock_timeout='400ms'");
 let caught:any;
 try{await client.query(statement)}catch(e){caught=e}
 assert.equal(caught?.code,"55P03",label+": independent writer must block on locked row");
 await client.query("ROLLBACK");
 console.log(label+"_BLOCKED_BY_REAL_ROW_LOCK_PASS");
}
async function cleanup(){
 // All objects are synthetic, uniquely named and live in a destroyed container.
 await q("DROP FUNCTION IF EXISTS finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)");
 for(const name of ["mkt_po_goods_receipts","mkt_po_shipments","mkt_purchase_orders"])
  await q("DROP TABLE IF EXISTS public."+name);
 await q("DROP SCHEMA finance_ops_private RESTRICT");
 await q("REVOKE USAGE ON SCHEMA public FROM "+finance+","+owner);
 await q("REVOKE "+finance+","+owner+" FROM postgres");
 await q("DROP ROLE "+finance);
 await q("DROP ROLE "+owner);
 const result=await q("SELECT to_regclass('public.mkt_purchase_orders') po,to_regclass('public.mkt_po_goods_receipts') gr,(SELECT count(*)::integer FROM pg_roles WHERE rolname IN ('ci_pr102_concurrency_finance','ci_pr102_concurrency_owner')) roles");
 assert.equal(result.rows[0].po,null);
 assert.equal(result.rows[0].gr,null);
 assert.equal(Number(result.rows[0].roles),0);
 console.log("CONCURRENCY_FIXTURE_CLEANUP_PASS");
}
async function main(){
 let a:pg.PoolClient|undefined,b:pg.PoolClient|undefined,c:pg.PoolClient|undefined;
 await setup();
 try{
  [a,b,c]=await Promise.all([db.connect(),db.connect(),db.connect()]);
  await a.query("BEGIN");
  await a.query("SET LOCAL ROLE "+finance);
  await a.query("SELECT set_config('app.marketplace_company_id','1',true)");
  const allowed=await a.query("SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(11,13,10,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') AS ok");
  assert.equal(allowed.rows[0].ok,true);
  const denied=await a.query("SELECT finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(31,33,35,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') AS ok");
  assert.equal(denied.rows[0].ok,false);
  console.log("DEF_INER_FUNCTION_TENANT_BOUND_LOCK_PASS");
  await Promise.all([
   blockedWriter(b,"UPDATE public.mkt_purchase_orders SET vendor_token='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' WHERE id=11","PO_TOKEN_ROTATION_WRITER"),
   blockedWriter(c,"UPDATE public.mkt_po_goods_receipts SET inspection_status='failed' WHERE id=13","GR_INDEPENDENT_WRITER")
  ]);
  await a.query("ROLLBACK");
  const changedPo=await b.query("UPDATE public.mkt_purchase_orders SET vendor_token='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' WHERE id=11 RETURNING id");
  const changedGr=await c.query("UPDATE public.mkt_po_goods_receipts SET inspection_status='failed' WHERE id=13 RETURNING id");
  assert.equal(changedPo.rowCount,1);
  assert.equal(changedGr.rowCount,1);
  const rotated=await q("SELECT vendor_token FROM public.mkt_purchase_orders WHERE id=11");
  assert.equal(rotated.rows[0].vendor_token,"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
  const other=await q("SELECT (SELECT status FROM public.mkt_purchase_orders WHERE id=31) po,(SELECT inspection_status FROM public.mkt_po_goods_receipts WHERE id=33) gr");
  assert.equal(other.rows[0].po,"confirmed");
  assert.equal(other.rows[0].gr,"passed");
  console.log("LOCK_RELEASE_AND_OTHER_COMPANY_UNCHANGED_PASS");
 }finally{
  if(a){try{await a.query("ROLLBACK")}catch{};a.release()}
  if(b){try{await b.query("ROLLBACK")}catch{};b.release()}
  if(c){try{await c.query("ROLLBACK")}catch{};c.release()}
  await cleanup();
 }
}
main().then(async()=>{await db.end();console.log("PR102_VENDOR_PARENT_LOCK_CONCURRENT_WRITERS_PASS")})
.catch(async e=>{console.error("PR102_CONCURRENCY_FAILED",e instanceof Error?e.message:e);
 try{await db.end()}catch{};process.exitCode=1});
