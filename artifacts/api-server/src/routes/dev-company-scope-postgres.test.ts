import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";

/** Disposable localhost PostgreSQL fixtures only. No real CST-DEV DB writes. */
const enabled=Boolean(process.env.PAYROLL_PG_E2E_URL);
describe.skipIf(!enabled)("DEV selected-company RLS policy proof",()=>{
  let pool:typeof import("@workspace/db")["pool"];
  const role="ci_bizportal_tenant_reader";
  const companies="public.ci_dev_scope_companies";
  const tables=["public.ci_dev_scope_customers","public.ci_dev_scope_documents"];
  const scope="company_id=NULLIF(current_setting('app.bizportal_company_id',true),'')::integer";
  async function read(company:string|null,table:string,filter=""){
    const c=await pool.connect();
    try{
      await c.query("BEGIN READ ONLY");
      await c.query("SET LOCAL ROLE "+role);
      if(company!==null)await c.query("SELECT set_config('app.bizportal_company_id',$1,true)",[company]);
      const result=await c.query("SELECT count(*)::int AS total FROM "+table+filter);
      await c.query("ROLLBACK");
      return Number(result.rows[0]?.total);
    }catch(error){
      await c.query("ROLLBACK").catch(()=>undefined);throw error;
    }finally{c.release();}
  }
  async function addGuards(){
    for(const t of tables)await pool.query(
      "CREATE POLICY ci_selected_tenant ON "+t+" AS RESTRICTIVE FOR SELECT TO "+role+" USING ("+scope+")"
    );
  }
  beforeAll(async()=>{
    const u=new URL(process.env.PAYROLL_PG_E2E_URL!);
    if(u.protocol!=="postgresql:"||u.hostname!=="127.0.0.1"||
       u.port!=="65432"||u.pathname!=="/payroll_ci"||
       u.username!=="postgres.xssrfshdrtdfupgqwfdw")throw Error("REFUSE_NON_DISPOSABLE_POSTGRES");
    process.env.APP_ENV="development";
    process.env.SUPABASE_DATABASE_URL_DEV=process.env.PAYROLL_PG_E2E_URL!;
    ({pool}=await import("@workspace/db"));
    await pool.query("CREATE ROLE "+role+" NOLOGIN NOBYPASSRLS NOINHERIT");
    await pool.query("CREATE TABLE "+companies+" (id int PRIMARY KEY,is_active boolean NOT NULL)");
    await pool.query("INSERT INTO "+companies+" VALUES (1,true),(2,true),(3,false)");
    for(const t of tables){
      await pool.query("CREATE TABLE "+t+" (id int PRIMARY KEY,company_id int NOT NULL)");
      await pool.query("INSERT INTO "+t+" VALUES (1,1),(2,2),(3,3)");
    }
    await pool.query("GRANT USAGE ON SCHEMA public TO "+role);
    await pool.query("GRANT SELECT ON "+[companies,...tables].join(",")+" TO "+role);
    await pool.query("ALTER TABLE "+companies+" ENABLE ROW LEVEL SECURITY");
    await pool.query("CREATE POLICY ci_companies_active ON "+companies+
      " FOR SELECT TO "+role+" USING (is_active IS TRUE)");
    for(const t of tables){
      await pool.query("ALTER TABLE "+t+" ENABLE ROW LEVEL SECURITY");
      await pool.query("CREATE POLICY ci_active_company ON "+t+
        " FOR SELECT TO "+role+" USING (company_id IN (SELECT id FROM "+companies+" WHERE is_active IS TRUE))");
    }
  });
  beforeEach(async()=>{
    for(const t of tables)await pool.query("DROP POLICY IF EXISTS ci_selected_tenant ON "+t);
  });
  afterAll(async()=>{
    if(!pool)return;
    for(const t of [...tables,companies])await pool.query("DROP TABLE IF EXISTS "+t+" CASCADE");
    await pool.query("REVOKE USAGE ON SCHEMA public FROM "+role);
    await pool.query("DROP ROLE IF EXISTS "+role);
    await pool.end();
  });
  it("reproduces existing active-company policy: two readable tenants",async()=>{
    for(const t of tables)expect(await read(null,t)).toBe(2);
  });
  it("denies all tenant rows if trusted scope is absent or empty",async()=>{
    await addGuards();
    for(const t of tables){
      expect(await read(null,t)).toBe(0);
      expect(await read("",t)).toBe(0);
      expect(await read("0",t)).toBe(0);
    }
  });
  it("limits a role to selected tenant while excluding inactive company",async()=>{
    await addGuards();
    for(const t of tables){
      expect(await read("1",t)).toBe(1);
      expect(await read("2",t)).toBe(1);
      expect(await read("3",t)).toBe(0);
      expect(await read("1",t," WHERE company_id=2")).toBe(0);
      expect(await read("2",t," WHERE company_id=1")).toBe(0);
    }
  });
  it("proves an unrestricted SQL caller can change an unsigned company GUC",async()=>{
    // A custom PostgreSQL GUC is NOT identity proof. If the DB credential or
    // arbitrary SQL is exposed to a caller, that caller can switch tenants.
    await addGuards();
    const c=await pool.connect();
    try{
      await c.query("BEGIN READ ONLY");
      await c.query("SET LOCAL ROLE "+role);
      await c.query("SELECT set_config('app.bizportal_company_id',$1,true)",["1"]);
      const denied=await c.query(
        "SELECT count(*)::int AS total FROM "+tables[0]+" WHERE company_id=2",
      );
      expect(Number(denied.rows[0]?.total)).toBe(0);
      // The SAME restricted role can set a different custom GUC. This is why
      // runtime must never expose direct SQL/connection credentials to users.
      await c.query("SELECT set_config('app.bizportal_company_id',$1,true)",["2"]);
      const exposed=await c.query(
        "SELECT count(*)::int AS total FROM "+tables[0]+" WHERE company_id=2",
      );
      expect(Number(exposed.rows[0]?.total)).toBe(1);
      await c.query("ROLLBACK");
    }catch(error){
      await c.query("ROLLBACK").catch(()=>undefined);
      throw error;
    }finally{c.release();}
  });

  it("retains read-only privileges and denies database UPDATE",async()=>{
    await addGuards();
    const c=await pool.connect();
    try{
      await c.query("BEGIN READ ONLY");
      await c.query("SET LOCAL ROLE "+role);
      const rights=await c.query(
        "SELECT has_table_privilege(current_user,$1,'SELECT') AS can_read,"+
        "has_table_privilege(current_user,$1,'UPDATE') AS can_update,"+
        "has_table_privilege(current_user,$1,'DELETE') AS can_delete",[tables[0]],
      );
      expect(rights.rows[0]).toMatchObject({can_read:true,can_update:false,can_delete:false});
      await c.query("ROLLBACK");
    }finally{c.release();}
  });
});
