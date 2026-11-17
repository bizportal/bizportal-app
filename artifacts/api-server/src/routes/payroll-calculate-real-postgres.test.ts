import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { calculateDevPayroll } from "./payroll-calculate";

const adminUrl=process.env.PAYROLL_CALC_PG_ADMIN_URL;
const restrictedUrl=process.env.PAYROLL_CALC_PG_RESTRICTED_URL;
const pg=describe.skipIf(!adminUrl || !restrictedUrl);

pg("real disposable PostgreSQL Calculate / RLS / rollback",()=>{
  let admin:Pool,restricted:Pool;
  const seed=`
  INSERT INTO public.employees(id,company_id,status) VALUES (101,1,'active'),(201,3,'active');
  INSERT INTO public.payroll_runs(id,company_id,year,month,status,posting_status)
     VALUES(32,1,2026,11,'draft','pending'),(33,3,2026,11,'draft','pending');
  INSERT INTO public.payroll_items(id,run_id,employee_id,is_paid,base_salary,allowance,
    gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,
    kasbon_deduction,total_deductions,net_salary) VALUES
    (11,32,101,false,3000,0,3000,0,0,0,0,0,0,3000),
    (22,33,201,false,4000,0,4000,0,0,0,0,0,0,4000);
  INSERT INTO public.cash_advances(id,company_id,employee_id,type,status,lifecycle_status,
    currency,amount,paid_amount,settled_amount,remaining_amount,
    approved_at,approved_by,disbursed_at,disbursed_by,accounting_entry_id,posting_status)
    VALUES
    (801,1,101,'kasbon','approved','outstanding','IDR',1000,300,200,500,
     '2026-10-01','approver','2026-10-02','treasury',555,'posted'),
    (802,3,201,'kasbon','approved','outstanding','IDR',2000,500,0,1500,
     '2026-10-01','approver','2026-10-02','treasury',556,'posted');
  INSERT INTO public.payroll_kasbon_auto_plans(company_id,employee_id,advance_id,
    choice,installment_amount,first_period)
    VALUES(1,101,801,'INSTALLMENT',100,'2026-11-01'),
      (3,201,802,'FULL',null,'2026-11-01');
  `;
  beforeAll(async()=>{
    // This fixture creates roles/tables: refuse every non-local, non-test target.
    const local=(value:string|undefined,username:string)=>{
      if(!value)return false;
      try {const url=new URL(value);
        return url.protocol==="postgresql:" && url.hostname==="127.0.0.1" &&
          url.port==="65436" && url.pathname==="/postgres" && url.username===username &&
          Boolean(url.password);
      }catch{return false;}
    };
    if(!local(adminUrl,"postgres") || !local(restrictedUrl,"bizportal_payroll_dev"))
      throw Error("PAYROLL_CALCULATE_DISPOSABLE_DATABASE_REQUIRED");
    admin=new Pool({connectionString:adminUrl,max:1});
    restricted=new Pool({connectionString:restrictedUrl,max:2});
    const schema=readFileSync(new URL("../../../../scripts/payroll-calculate/disposable-schema.sql",import.meta.url),"utf8");
    await admin.query(schema);
    await restricted.query("SELECT current_user");
    vi.stubEnv("APP_ENV","development");
    vi.stubEnv("PAYROLL_DEV_CALCULATE_ENABLED","true");
  },30000);
  beforeEach(async()=>{
    await admin.query(`TRUNCATE TABLE public.payroll_kasbon_auto_reservations,
      public.payroll_kasbon_auto_plans,public.payroll_cash_advance_allocations,
      public.cash_advance_installment_schedules,public.cash_advances,
      public.payroll_items,public.payroll_runs,public.employees
      RESTART IDENTITY CASCADE`);
    await admin.query(seed);
  },15000);
  afterAll(async()=>{await Promise.allSettled([restricted?.end(),admin?.end()]);vi.unstubAllEnvs();});
  it("prepares one restricted real-SQL reservation while leaving Draft, then replays exactly",async()=>{
    const first=await calculateDevPayroll(restricted,1,32);
    expect(first).toMatchObject({status:"draft",net:"2900.00",
      preparedReservations:1,updatedItems:1,approved:false,accountingPosted:false,salaryPaid:false});
    const repeat=await calculateDevPayroll(restricted,1,32);
    expect(repeat).toMatchObject({status:"draft",net:"2900.00",
      preparedReservations:0,updatedItems:0});
    const data=await admin.query(`SELECT (SELECT count(*)::int FROM public.payroll_kasbon_auto_reservations WHERE company_id=1) AS holds,
      (SELECT kasbon_deduction::text FROM public.payroll_items WHERE id=11) AS deduction,
      (SELECT net_salary::text FROM public.payroll_items WHERE id=11) AS net,
      (SELECT status FROM public.payroll_runs WHERE id=32) AS status,
      (SELECT settled_amount::text FROM public.cash_advances WHERE id=801) AS settled,
      (SELECT kasbon_deduction::text FROM public.payroll_items WHERE id=22) AS other_company`);
    expect(data.rows[0]).toMatchObject({holds:1,deduction:"100.00",net:"2900.00",
      status:"draft",settled:"200",other_company:"0"});
  });
  it("selects FULL balance from the existing plan without duplicate settlement",async()=>{
    await admin.query("UPDATE public.payroll_kasbon_auto_plans SET choice='FULL',installment_amount=null WHERE company_id=1");
    const r=await calculateDevPayroll(restricted,1,32);
    expect(r.net).toBe("2500.00");
    const hold=await admin.query("SELECT amount::text,state FROM public.payroll_kasbon_auto_reservations WHERE company_id=1");
    expect(hold.rows[0]).toMatchObject({amount:"500.00",state:"prepared"});
  });
  it("cannot calculate another company's run with requested company scope",async()=>{
    await expect(calculateDevPayroll(restricted,1,33)).rejects.toThrow("PAYROLL_CALCULATE_RUN_NOT_FOUND");
    await expect(calculateDevPayroll(restricted,3,32)).rejects.toThrow("PAYROLL_CALCULATE_RUN_NOT_FOUND");
    const data=await admin.query("SELECT count(*)::int n FROM public.payroll_kasbon_auto_reservations");
    expect(data.rows[0].n).toBe(0);
  });
  it("rejects missing plan with no partial item or hold mutation",async()=>{
    await admin.query("DELETE FROM public.payroll_kasbon_auto_plans WHERE company_id=1");
    await expect(calculateDevPayroll(restricted,1,32)).rejects.toThrow("PAYROLL_CALCULATE_PLAN_OR_ADVANCE_NOT_READY");
    const r=await admin.query(`SELECT (SELECT count(*)::int FROM public.payroll_kasbon_auto_reservations) AS n,
      (SELECT kasbon_deduction::text FROM public.payroll_items WHERE id=11) AS d`);
    expect(r.rows[0]).toMatchObject({n:0,d:"0"});
  });
  it("rolls back first payroll item update when the SQL reservation insert is rejected",async()=>{
    await admin.query(`CREATE OR REPLACE FUNCTION public.payroll_calculate_fixture_deny()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture reservation denial'; END $$`);
    await admin.query(`CREATE TRIGGER payroll_calculate_fixture_insert_deny BEFORE INSERT
      ON public.payroll_kasbon_auto_reservations FOR EACH ROW
      EXECUTE FUNCTION public.payroll_calculate_fixture_deny()`);
    try {
      await expect(calculateDevPayroll(restricted,1,32)).rejects.toThrow();
      const r=await admin.query(`SELECT (SELECT count(*)::int FROM public.payroll_kasbon_auto_reservations) AS n,
        (SELECT kasbon_deduction::text FROM public.payroll_items WHERE id=11) AS d,
        (SELECT net_salary::text FROM public.payroll_items WHERE id=11) AS net`);
      expect(r.rows[0]).toMatchObject({n:0,d:"0",net:"3000"});
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS payroll_calculate_fixture_insert_deny ON public.payroll_kasbon_auto_reservations");
      await admin.query("DROP FUNCTION IF EXISTS public.payroll_calculate_fixture_deny()");
    }
  });
  it("cannot write cash advance principal or foreign-company salary through restricted role",async()=>{
    await expect(restricted.query("UPDATE public.cash_advances SET remaining_amount=0 WHERE id=801")).rejects.toThrow();
    await expect(restricted.query("UPDATE public.payroll_items SET base_salary=0 WHERE id=22")).rejects.toThrow();
    const r=await admin.query("SELECT remaining_amount::text AS remaining FROM public.cash_advances WHERE id=801");
    expect(r.rows[0].remaining).toBe("500");
  });
  it("concurrent Calculate requests cannot reserve or deduct the same loan twice",async()=>{
    const results=await Promise.allSettled([
      calculateDevPayroll(restricted,1,32),calculateDevPayroll(restricted,1,32),
    ]);
    const failures=results.filter(r=>r.status==="rejected");
    expect(failures.map(f=>f.status==="rejected" ?
      {code:(f.reason as {code?:string}).code,message:(f.reason as Error).message} : null)).toEqual([]);
    const counts=await admin.query(`SELECT
      (SELECT count(*)::int FROM public.payroll_kasbon_auto_reservations WHERE company_id=1) AS n,
      (SELECT kasbon_deduction::text FROM public.payroll_items WHERE id=11) AS deduction`);
    expect(counts.rows[0]).toMatchObject({n:1,deduction:"100.00"});
  });
  it("refuses a changed installment choice after an existing prepared hold",async()=>{
    await calculateDevPayroll(restricted,1,32);
    await admin.query("UPDATE public.payroll_kasbon_auto_plans SET choice='FULL',installment_amount=null WHERE company_id=1");
    await expect(calculateDevPayroll(restricted,1,32)).rejects.toThrow("PAYROLL_CALCULATE_PLAN_OR_ADVANCE_NOT_READY");
    const data=await admin.query("SELECT amount::text FROM public.payroll_kasbon_auto_reservations WHERE company_id=1");
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].amount).toBe("100.00");
  });
  it("refuses legacy pending installment schedule instead of double charging",async()=>{
    await admin.query("INSERT INTO public.cash_advance_installment_schedules(id,company_id,advance_id,status) VALUES(77,1,801,'pending')");
    await expect(calculateDevPayroll(restricted,1,32)).rejects.toThrow("PAYROLL_CALCULATE_LEGACY_SCHEDULE_REQUIRES_RECONCILIATION");
    const holds=await admin.query("SELECT count(*)::int n FROM public.payroll_kasbon_auto_reservations");
    expect(holds.rows[0].n).toBe(0);
  });
  it("permits payroll without an actual kasbon and does not fabricate any hold",async()=>{
    await admin.query("DELETE FROM public.payroll_kasbon_auto_plans WHERE company_id=1");
    await admin.query("DELETE FROM public.cash_advances WHERE company_id=1");
    const result=await calculateDevPayroll(restricted,1,32);
    expect(result).toMatchObject({status:"draft",net:"3000.00",
      preparedReservations:0,updatedItems:0});
    const holds=await admin.query("SELECT count(*)::int n FROM public.payroll_kasbon_auto_reservations");
    expect(holds.rows[0].n).toBe(0);
  });
});
