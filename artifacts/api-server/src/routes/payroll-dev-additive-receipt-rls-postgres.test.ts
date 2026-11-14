import {afterAll,beforeAll,describe,expect,it} from "vitest";

/** Tests ADDITIVE restrictive policy against synthetic objects in localhost CI only. */
const enabled=Boolean(process.env.PAYROLL_PG_E2E_URL);
describe.skipIf(!enabled)("Payroll DEV additive receipt guard compatibility",()=>{
 let pool:typeof import("@workspace/db")["pool"];
 const table="public.ci_payroll_receipt_probe";
 const role="ci_payroll_receipt_probe";
 const approver="ci_payroll_approver_probe";
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
  await pool.query("CREATE ROLE "+approver+" NOLOGIN NOBYPASSRLS NOINHERIT");
  await pool.query("CREATE TABLE "+table+" (id int primary key,company_id int not null,status text not null,posting_status text not null,approved_at timestamptz,notes text,accounting_entry_id int,payment_entry_id int)");
  await pool.query("INSERT INTO "+table+" (id,company_id,status,posting_status) VALUES (1,1,'draft','pending'),(2,2,'draft','pending')");
  await pool.query("GRANT USAGE ON SCHEMA public TO "+role);
  await pool.query("GRANT USAGE ON SCHEMA public TO "+approver);
  await pool.query("GRANT SELECT ON "+table+" TO "+role);
  await pool.query("GRANT SELECT ON "+table+" TO "+approver);
  await pool.query("GRANT UPDATE(status,approved_at,notes) ON "+table+" TO "+role);
  await pool.query("GRANT UPDATE(status,approved_at,notes) ON "+table+" TO "+approver);
  await pool.query("ALTER TABLE "+table+" ENABLE ROW LEVEL SECURITY");
  await pool.query("CREATE POLICY ci_read ON "+table+" FOR SELECT TO "+role+" USING ("+company+")");
  await pool.query("CREATE POLICY ci_approver_read ON "+table+" FOR SELECT TO "+approver+" USING ("+company+")");
  await pool.query("CREATE POLICY ci_legacy_review ON "+table+" FOR UPDATE TO "+role+
   " USING ("+company+" AND status='draft' AND posting_status='pending' AND accounting_entry_id IS NULL AND payment_entry_id IS NULL)"+
   " WITH CHECK ("+company+" AND status='reviewed' AND posting_status='pending' AND accounting_entry_id IS NULL AND payment_entry_id IS NULL)");
  await pool.query("CREATE POLICY ci_approver_write ON "+table+" FOR UPDATE TO "+approver+
   " USING ("+company+" AND status='draft' AND approved_at IS NULL AND posting_status='pending' AND accounting_entry_id IS NULL AND payment_entry_id IS NULL)"+
   " WITH CHECK ("+company+" AND status='reviewed' AND approved_at IS NOT NULL AND posting_status='pending' AND accounting_entry_id IS NULL AND payment_entry_id IS NULL AND coalesce(notes,'') LIKE '%[PAYROLL_SUPER_ADMIN_APPROVAL_V1]%')");
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
   await pool.query("REVOKE USAGE ON SCHEMA public FROM "+approver);
   await pool.query("DROP ROLE IF EXISTS "+approver);
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
 it("models legacy HR review without approved_at write capability",async()=>{
  // Synthetic database only: do not alter the CST-DEV grants during this test.
  await pool.query("REVOKE UPDATE(approved_at) ON "+table+" FROM "+role);
  try {
   const hr=await scoped(1,c=>c.query(
    "UPDATE "+table+" SET status='reviewed',notes='HR verified inputs' WHERE id=1 RETURNING status,approved_at",
   ));
   expect(hr.rows[0]).toMatchObject({status:"reviewed",approved_at:null});
   await expect(scoped(1,c=>c.query(
    "UPDATE "+table+" SET status='reviewed',approved_at=now(),notes=$1 WHERE id=1 RETURNING id",
    [marker+" "+JSON.stringify({actorId:"forged",actorEmail:"forged@example.test",digest:"a".repeat(64),note:"synthetic forged approval"})],
   ))).rejects.toThrow();
   const row=await pool.query("SELECT status,approved_at,notes FROM "+table+" WHERE id=1");
   expect(row.rows[0]).toMatchObject({status:"draft",approved_at:null,notes:null});
  } finally {
   await pool.query("GRANT UPDATE(approved_at) ON "+table+" TO "+role);
  }
 });
 it("proves split writer privileges and tenant RLS without rewriting historical review",async()=>{
  // Role isolation is exercised on disposable localhost PostgreSQL only.
  await pool.query("REVOKE UPDATE(approved_at) ON "+table+" FROM "+role);
  const asApprover=async(companyId:number,sql:string,args:unknown[]=[])=>{
   const c=await pool.connect();
   try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE "+approver);
    await c.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
    const identity=await c.query("SELECT current_user AS role");
    expect(identity.rows[0].role).toBe(approver);
    const result=await c.query(sql,args);
    await c.query("ROLLBACK");
    return result;
   }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}
   finally{c.release();}
  };
  try {
   const review=await scoped(1,c=>c.query("UPDATE "+table+" SET status='reviewed',notes='HR reviewed' WHERE id=1 RETURNING approved_at"));
   expect(review.rowCount).toBe(1);
   expect(review.rows[0].approved_at).toBeNull();
   await expect(scoped(1,c=>c.query("UPDATE "+table+" SET status='reviewed',approved_at=now() WHERE id=1"))).rejects.toThrow();
   const forgedMarker=marker+" "+JSON.stringify({actorId:"ci",actorEmail:"ci@example.test",digest:"a".repeat(64),note:"Synthetic approval from CI"});
   const cross=await asApprover(1,"UPDATE "+table+" SET status='reviewed',approved_at=now(),notes=$1 WHERE id=2 RETURNING id",[forgedMarker]);
   expect(cross.rowCount).toBe(0);
   await expect(asApprover(1,"UPDATE "+table+" SET status='reviewed',approved_at=now(),notes='invalid' WHERE id=1 RETURNING id")).rejects.toThrow();
   const valid=await asApprover(1,"UPDATE "+table+" SET status='reviewed',approved_at=now(),notes=$1 WHERE id=1 RETURNING id",[forgedMarker]);
   expect(valid.rowCount).toBe(1);
   const persisted=await pool.query("SELECT status,approved_at,notes FROM "+table+" WHERE id=1");
   expect(persisted.rows[0]).toMatchObject({status:"draft",approved_at:null,notes:null});
  }finally {
   await pool.query("GRANT UPDATE(approved_at) ON "+table+" TO "+role);
  }
 });
 it("denies approver writes without company scope and denies posting-column writes",async()=>{
  const c=await pool.connect();
  try {
   await c.query("BEGIN");
   await c.query("SET LOCAL ROLE "+approver);
   const rights=await c.query(
    "SELECT has_column_privilege(current_user,$1,'approved_at','UPDATE') AS can_stamp,"+
    "has_column_privilege(current_user,$1,'accounting_entry_id','UPDATE') AS can_post_accounting,"+
    "has_column_privilege(current_user,$1,'payment_entry_id','UPDATE') AS can_post_payment",
    [table],
   );
   expect(rights.rows[0]).toMatchObject({
    can_stamp:true,can_post_accounting:false,can_post_payment:false,
   });
   const receipt=marker+" "+JSON.stringify({
    actorId:"synthetic",actorEmail:"synthetic@example.test",
    digest:"a".repeat(64),note:"Synthetic approval receipt",
   });
   const missingScope=await c.query(
    "UPDATE "+table+" SET status='reviewed',approved_at=now(),notes=$1 WHERE id=1 RETURNING id",
    [receipt],
   );
   expect(missingScope.rowCount).toBe(0);
   await c.query("ROLLBACK");
  }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}
  finally{c.release();}
  const original=await pool.query("SELECT status,approved_at,accounting_entry_id,payment_entry_id FROM "+table+" WHERE id=1");
  expect(original.rows[0]).toMatchObject({
   status:"draft",approved_at:null,accounting_entry_id:null,payment_entry_id:null,
  });
 });
 it("preserves column-scoped UPDATE and denies blanket table UPDATE",async()=>{
  const r=await scoped(1,c=>c.query("SELECT has_table_privilege(current_user,$1,'UPDATE') AS table_write,has_column_privilege(current_user,$1,'status','UPDATE') AS status_write,has_column_privilege(current_user,$1,'approved_at','UPDATE') AS approved_write",[table]));
  expect(r.rows[0]).toMatchObject({table_write:false,status_write:true,approved_write:true});
 });
});
