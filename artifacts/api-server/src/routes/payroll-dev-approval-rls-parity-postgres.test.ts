import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** All RLS mutations affect an artificial table in localhost CI PostgreSQL ONLY. */
const enabled=Boolean(process.env.PAYROLL_PG_E2E_URL);
describe.skipIf(!enabled)("DEV Payroll HR-review policy versus strict receipt candidate",()=>{
  let pool:typeof import("@workspace/db")["pool"];
  const table="public.ci_payroll_policy_probe_runs";
  const scope="company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer";
  const originalUsing=scope+" AND status='draft' AND posting_status='pending' AND accounting_entry_id IS NULL AND payment_entry_id IS NULL";
  const originalCheck=scope+" AND status='reviewed' AND posting_status='pending' AND accounting_entry_id IS NULL AND payment_entry_id IS NULL";
  const strictUsing=originalUsing+" AND approved_at IS NULL";
  const strictCheck=originalCheck+" AND approved_at IS NOT NULL AND notes LIKE '%[PAYROLL_SUPER_ADMIN_APPROVAL_V1]%'";

  async function setPolicy(using:string,check:string){
    await pool.query("ALTER POLICY ci_review_transition ON "+table+" USING ("+using+") WITH CHECK ("+check+")");
  }
  async function asRole<T>(companyId:number,callback:(client:{
    query:(sql:string,args?:unknown[])=>Promise<{rowCount:number|null;rows:any[]}>;
  })=>Promise<T>):Promise<T>{
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE ci_payroll_policy_probe");
      await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
      const value=await callback(client);
      await client.query("ROLLBACK"); // Never persist test-role updates.
      return value;
    }catch(error){
      await client.query("ROLLBACK").catch(()=>undefined);
      throw error;
    }finally{client.release();}
  }
  beforeAll(async()=>{
    const u=new URL(process.env.PAYROLL_PG_E2E_URL!);
    if(u.protocol!=="postgresql:"||u.hostname!=="127.0.0.1"||
       u.port!=="65432"||u.pathname!=="/payroll_ci"||
       u.username!=="postgres.xssrfshdrtdfupgqwfdw")throw Error("REFUSE_NON_DISPOSABLE_POSTGRES");
    process.env.APP_ENV="development";
    process.env.SUPABASE_DATABASE_URL_DEV=process.env.PAYROLL_PG_E2E_URL!;
    ({pool}=await import("@workspace/db"));
    await pool.query("CREATE ROLE ci_payroll_policy_probe NOLOGIN NOBYPASSRLS NOINHERIT");
    await pool.query("CREATE TABLE "+table+" ("+
      "id integer PRIMARY KEY,company_id integer NOT NULL,"+
      "status text NOT NULL,posting_status text NOT NULL,"+
      "approved_at timestamptz,notes text,"+
      "accounting_entry_id integer,payment_entry_id integer)");
    await pool.query("INSERT INTO "+table+
      "(id,company_id,status,posting_status) VALUES (1,1,'draft','pending'),(2,2,'draft','pending')");
    await pool.query("GRANT USAGE ON SCHEMA public TO ci_payroll_policy_probe");
    await pool.query("GRANT SELECT ON "+table+" TO ci_payroll_policy_probe");
    await pool.query("GRANT UPDATE(status,approved_at,notes) ON "+table+" TO ci_payroll_policy_probe");
    await pool.query("ALTER TABLE "+table+" ENABLE ROW LEVEL SECURITY");
    await pool.query("CREATE POLICY ci_read ON "+table+" FOR SELECT TO ci_payroll_policy_probe USING ("+scope+")");
    await pool.query("CREATE POLICY ci_review_transition ON "+table+
      " FOR UPDATE TO ci_payroll_policy_probe USING ("+originalUsing+") WITH CHECK ("+originalCheck+")");
    await pool.query(
      "CREATE FUNCTION public.ci_payroll_review_reopen_guard() RETURNS trigger LANGUAGE plpgsql AS $$"+
      "BEGIN IF OLD.status='reviewed' AND NEW.status IS DISTINCT FROM OLD.status AND "+
      "NOT (NEW.status='approved' AND NEW.accounting_entry_id IS NOT NULL) "+
      "THEN RAISE EXCEPTION 'PAYROLL_HR_REVIEW_CANNOT_BE_REOPENED' USING ERRCODE='23514'; END IF; "+
      "RETURN NEW; END $$",
    );
    await pool.query("CREATE TRIGGER ci_payroll_review_reopen_guard BEFORE UPDATE OF status ON "+table+
      " FOR EACH ROW EXECUTE FUNCTION public.ci_payroll_review_reopen_guard()");
  });
  afterAll(async()=>{
    if(pool){
      await pool.query("DROP TABLE IF EXISTS "+table+" CASCADE");
      await pool.query("DROP FUNCTION IF EXISTS public.ci_payroll_review_reopen_guard()");
      await pool.query("REVOKE USAGE ON SCHEMA public FROM ci_payroll_policy_probe");
      await pool.query("DROP ROLE IF EXISTS ci_payroll_policy_probe");
      await pool.end();
    }
  });
  beforeEach(async()=>{await setPolicy(originalUsing,originalCheck);});
  it("reproduces DEV review: unsigned Draft->reviewed is allowed by existing policy",async()=>{
    const count=await asRole(1,async client=>{
      const changed=await client.query("UPDATE "+table+" SET status='reviewed' WHERE id=1 RETURNING status,approved_at,notes");
      expect(changed.rows[0]).toMatchObject({status:"reviewed",approved_at:null,notes:null});
      return changed.rowCount;
    });
    expect(count).toBe(1);
  });
  it("confirms narrow column UPDATE with no table-wide UPDATE",async()=>{
    const result=await asRole(1,client=>client.query(
      "SELECT current_user role,"+
      "has_table_privilege(current_user,$1,'UPDATE') can_update_table,"+
      "has_column_privilege(current_user,$1,'status','UPDATE') can_update_status,"+
      "has_column_privilege(current_user,$1,'notes','UPDATE') can_update_notes",[table],
    ));
    expect(result.rows[0]).toMatchObject({
      role:"ci_payroll_policy_probe",can_update_table:false,
      can_update_status:true,can_update_notes:true,
    });
  });
  it("strict candidate blocks unsigned HR-style transition, revealing compatibility risk",async()=>{
    await setPolicy(strictUsing,strictCheck);
    await expect(asRole(1,client=>client.query(
      "UPDATE "+table+" SET status='reviewed' WHERE id=1 RETURNING id",
    ))).rejects.toThrow();
    const after=await pool.query("SELECT status,approved_at,notes FROM "+table+" WHERE id=1");
    expect(after.rows[0]).toMatchObject({status:"draft",approved_at:null,notes:null});
  });
  it("strict candidate requires both approved_at and durable receipt",async()=>{
    await setPolicy(strictUsing,strictCheck);
    await expect(asRole(1,client=>client.query(
      "UPDATE "+table+" SET status='reviewed',approved_at=now() WHERE id=1 RETURNING id",
    ))).rejects.toThrow();
    await expect(asRole(1,client=>client.query(
      "UPDATE "+table+" SET status='reviewed',notes='[PAYROLL_SUPER_ADMIN_APPROVAL_V1]' WHERE id=1 RETURNING id",
    ))).rejects.toThrow();
  });
  it("strict candidate permits only first marked transition, not replay",async()=>{
    await setPolicy(strictUsing,strictCheck);
    const counts=await asRole(1,async client=>{
      const one=await client.query(
        "UPDATE "+table+" SET status='reviewed',approved_at=now(),"+
        "notes='[PAYROLL_SUPER_ADMIN_APPROVAL_V1] synthetic test receipt' WHERE id=1 RETURNING id",
      );
      const two=await client.query(
        "UPDATE "+table+" SET status='reviewed',approved_at=now(),"+
        "notes='[PAYROLL_SUPER_ADMIN_APPROVAL_V1] replay' WHERE id=1 RETURNING id",
      );
      return [one.rowCount,two.rowCount];
    });
    expect(counts).toEqual([1,0]);
  });
  it("strict candidate rejects cross-company reads and updates",async()=>{
    await setPolicy(strictUsing,strictCheck);
    const count=await asRole(1,async client=>{
      const found=await client.query("SELECT id FROM "+table+" WHERE company_id=2");
      expect(found.rows).toHaveLength(0);
      const update=await client.query(
        "UPDATE "+table+" SET status='reviewed',approved_at=now(),"+
        "notes='[PAYROLL_SUPER_ADMIN_APPROVAL_V1]' WHERE id=2 RETURNING id",
      );
      return update.rowCount;
    });
    expect(count).toBe(0);
  });
});
