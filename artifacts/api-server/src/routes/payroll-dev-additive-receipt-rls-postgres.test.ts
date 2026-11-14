import {afterAll,beforeAll,describe,expect,it} from "vitest";

/** Tests ADDITIVE restrictive policy against synthetic objects in localhost CI only. */
const enabled=Boolean(process.env.PAYROLL_PG_E2E_URL);
describe.skipIf(!enabled)("Payroll DEV additive receipt guard compatibility",()=>{
 let pool:typeof import("@workspace/db")["pool"];
 const table="public.ci_payroll_receipt_probe";
 const role="ci_payroll_receipt_probe";
 const marker="[PAYROLL_SUPER_ADMIN_APPROVAL_V1]";
 const company="company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer";
 async function scoped<T>(companyId:number,run:(c:{query:(sql:string,args?:unknown[])=>Promise<{rowCount:number|null;rows:any[]}>})=>Promise<T>):Promise<T>{
  const c=await pool.connect();
  try {
   await c.query("BEGIN");
   await c.query("SET LOCAL ROLE "+role);
   await c.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
   const result=await run(c);
   await c.query("ROLLBACK");
   return result;
  }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}
  finally{c.release();}
 }
 beforeAll(async()=>{
  const u=new URL(process.env.PAYROLL_PG_E2E_URL!);
  if(u.protocol!=="postgresql:"||u.hostname!=="127.0.0.1"||u.port!=="65432"||
    u.pathname!=="/payroll_ci"||u.username!=="postgres.xssrfshdrtdfupgqwfdw")
    throw Error("REFUSE_NON_DISPOSABLE_POSTGRES");
  process.env.APP_ENV="development";
  process.env.SUPABASE_DATABASE_URL_DEV=process.env.PAYROLL_PG_E2E_URL!;
  ({pool}=await import("@workspace/db"));
  await pool.query("CREATE ROLE "+role+" NOLOGIN NOBYPASSRLS NOINHERIT");
  await pool.query("CREATE TABLE "+table+" (id int primary key,company_id int not null,status text not null,posting_status text not null,approved_at timestamptz,notes text,accounting_entry_id int,payment_entry_id int)");
  await pool.query("INSERT INTO "+table+" (id,company_id,status,posting_status) VALUES (1,1,'draft','pending'),(2,2,'draft','pending')");
  await pool.query("GRANT USAGE ON SCHEMA public TO "+role);
  await pool.query("GRANT SELECT ON "+table+" TO "+role);
  await pool.query("GRANT UPDATE(status,approved_at,notes) ON "+table+" TO "+role);
  await pool.query("ALTER TABLE "+table+" ENABLE ROW LEVEL SECURITY");
  await pool.query("CREATE POLICY ci_read ON "+table+" FOR SELECT TO "+role+" USING ("+company+")");
  await pool.query("CREATE POLICY ci_legacy_review ON "+table+" FOR UPDATE TO "+role+
   " USING ("+company+" AND status='draft' AND posting_status='pending' AND accounting_entry_id IS NULL AND payment_entry_id IS NULL)"+
   " WITH CHECK ("+company+" AND status='reviewed' AND posting_status='pending' AND accounting_entry_id IS NULL AND payment_entry_id IS NULL)");
  // AND semantics for restrictive policies prevents a second permissive path.
  await pool.query("CREATE POLICY ci_receipt_gate ON "+table+" AS RESTRICTIVE FOR UPDATE TO "+role+
   " USING (approved_at IS NULL) WITH CHECK ("+
   "(approved_at IS NULL AND coalesce(notes,'') NOT LIKE '%[PAYROLL_SUPER_ADMIN_APPROVAL_V1]%')"+
   " OR (approved_at IS NOT NULL AND coalesce(notes,'') LIKE '%[PAYROLL_SUPER_ADMIN_APPROVAL_V1]%'))");
 });
 afterAll(async()=>{
  if(pool){
   await pool.query("DROP TABLE IF EXISTS "+table+" CASCADE");
   await pool.query("REVOKE USAGE ON SCHEMA public FROM "+role);
   await pool.query("DROP ROLE IF EXISTS "+role);
   await pool.end();
  }
 });
 it("keeps unsigned HR review when approved_at is null",async()=>{
  const r=await scoped(1,c=>c.query("UPDATE "+table+" SET status='reviewed',notes='HR verified inputs' WHERE id=1 RETURNING status,approved_at,notes"));
  expect(r.rowCount).toBe(1);
  expect(r.rows[0]).toMatchObject({status:"reviewed",approved_at:null,notes:"HR verified inputs"});
 });
 it("requires marker whenever an approval date is written",async()=>{
  await expect(scoped(1,c=>c.query("UPDATE "+table+" SET status='reviewed',approved_at=now(),notes='ordinary HR review' WHERE id=1 RETURNING id"))).rejects.toThrow();
  const stored=await pool.query("SELECT status,approved_at FROM "+table+" WHERE id=1");
  expect(stored.rows[0]).toMatchObject({status:"draft",approved_at:null});
 });
 it("rejects marker without approval date to prevent false receipt classification",async()=>{
  await expect(scoped(1,c=>c.query("UPDATE "+table+" SET status='reviewed',notes=$1 WHERE id=1 RETURNING id",[marker+" fake"]))).rejects.toThrow();
 });
 it("accepts approved_at plus durable receipt marker",async()=>{
  const receipt=marker+" "+JSON.stringify({actorId:"ci-only",actorEmail:"ci@example.test",digest:"a".repeat(64),note:"Synthetic approved data"});
  const r=await scoped(1,c=>c.query("UPDATE "+table+" SET status='reviewed',approved_at=now(),notes=$1 WHERE id=1 RETURNING id,approved_at,notes",[receipt]));
  expect(r.rowCount).toBe(1);
  expect(r.rows[0].approved_at).not.toBeNull();
  expect(r.rows[0].notes).toContain(marker);
 });
 it("maintains tenant isolation and one-time draft transition",async()=>{
  const counts=await scoped(1,async c=>{
   const cross=await c.query("UPDATE "+table+" SET status='reviewed' WHERE id=2 RETURNING id");
   const first=await c.query("UPDATE "+table+" SET status='reviewed' WHERE id=1 RETURNING id");
   const replay=await c.query("UPDATE "+table+" SET status='reviewed' WHERE id=1 RETURNING id");
   return [cross.rowCount,first.rowCount,replay.rowCount];
  });
  expect(counts).toEqual([0,1,0]);
 });
 it("preserves column-scoped UPDATE and denies blanket table UPDATE",async()=>{
  const r=await scoped(1,c=>c.query("SELECT has_table_privilege(current_user,$1,'UPDATE') AS table_write,has_column_privilege(current_user,$1,'status','UPDATE') AS status_write,has_column_privilege(current_user,$1,'approved_at','UPDATE') AS approved_write",[table]));
  expect(r.rows[0]).toMatchObject({table_write:false,status_write:true,approved_write:true});
 });
});
