import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { calculateDevPayroll } from "./payroll-calculate";

type Item = Record<string,any>;
type Hold = Record<string,any>;
function fixture(options:{loan?:boolean;choice?:"FULL"|"INSTALLMENT";eligible?:boolean}={}) {
  let items:Item[]=[{id:11,employee_id:101,is_paid:false,cash_advance_id:null,
    employee_company:1,employee_status:"active",employee_deleted:null,
    base_salary:"3000.00",allowance:"0.00",gross_salary:"3000.00",
    bpjs_jht_employee:"0.00",bpjs_kes_employee:"0.00",pph21:"0.00",
    other_deductions:"0.00",kasbon_deduction:"0.00",
    total_deductions:"0.00",net_salary:"3000.00"}];
  let holds:Hold[]=[];
  const advance={id:801,companyId:1,employeeId:101,type:"kasbon",status:"approved",
    lifecycleStatus:"outstanding",currency:"IDR",amount:"1000.00",
    paidAmount:"300.00",settledAmount:"200.00",remainingAmount:"500.00",
    approvedAt:"2026-10-01",approvedBy:"owner-approval",
    disbursedAt:"2026-10-02",disbursedBy:"treasury",
    accountingEntryId:55,postingStatus:"posted",voidedAt:null};
  const plans=[{employeeId:101,advanceId:801,choice:options.choice??"INSTALLMENT",
    installmentAmount:(options.choice??"INSTALLMENT")==="FULL"?null:"100.00",
    firstPeriod:"2026-11-01"}];
  const run={id:32,company_id:1,year:2026,month:11,status:"draft",posting_status:"pending",
    approved_at:null,accounting_entry_id:null,payment_entry_id:null};
  const calls:string[]=[];
  let onInsert:()=>void=()=>{};
  let onCommit:()=>void=()=>{};
  let currentUser="bizportal_payroll_dev",canKasbon=true,active=[{id:101}];
  let snapshot:{items:Item[];holds:Hold[]}|null=null;
  let released=0;
  const result=(rows:any[])=>({rows,rowCount:rows.length});
  const client={query:async(sql:string,args:any[]=[])=>{
    calls.push(sql.trim());
    const normalized=sql.trim().replace(/\s+/g," ");
    if(normalized.startsWith("BEGIN ")) {
      snapshot={items:structuredClone(items),holds:structuredClone(holds)}; return result([]);
    }
    if(normalized==="ROLLBACK"){
      if(snapshot){items=snapshot.items;holds=snapshot.holds;}snapshot=null;return result([]);
    }
    if(normalized==="COMMIT"){onCommit();snapshot=null;return result([]);}
    if(normalized.includes("set_config('app.payroll_company_id'"))return result([{set_config:"1"}]);
    if(normalized.includes("current_user AS role"))return result([{
      role:currentUser,company:"1",can_write_kasbon:canKasbon,
      can_write_net:true,can_write_deductions:true,can_reserve:true,
    }]);
    if(normalized.startsWith("SELECT pg_advisory_xact_lock"))return result([{}]);
    if(normalized.includes("FROM public.payroll_runs")&&normalized.includes("FOR UPDATE"))
      return result([run]);
    if(normalized.includes("FROM public.employees")&&normalized.includes("ORDER BY id"))
      return result(active);
    if(normalized.includes("FROM public.payroll_items pi LEFT JOIN public.employees"))
      return result(structuredClone(items));
    if(normalized.includes("FROM public.cash_advances WHERE"))
      return result(options.loan===false?[]:[{...advance,
        approvedAt:options.eligible===false?null:advance.approvedAt}]);
    if(normalized.includes("FROM public.payroll_cash_advance_allocations"))return result([]);
    if(normalized.includes("FROM public.cash_advance_installment_schedules"))return result([]);
    if(normalized.includes("FROM public.payroll_kasbon_auto_plans"))
      return result(options.loan===false?[]:plans);
    if(normalized.includes("FROM public.payroll_kasbon_auto_reservations")&&
      normalized.includes("LEFT JOIN public.cash_advances"))return result(holds.map(h=>({
      payrollItemId:h.payrollItemId,employeeId:h.employeeId,amount:h.amount,
      heldBalance:h.balanceAtPreparation,currentBalance:advance.remainingAmount,
      advanceStatus:advance.status,advanceLifecycle:advance.lifecycleStatus,
      advanceApprovedAt:advance.approvedAt,advanceApprovedBy:advance.approvedBy,
      advanceDisbursedAt:advance.disbursedAt,advanceDisbursedBy:advance.disbursedBy,
      advanceAccountingEntryId:advance.accountingEntryId,
      advancePostingStatus:advance.postingStatus,advanceVoidedAt:advance.voidedAt,state:h.state,
    })));
    if(normalized.includes("FROM public.payroll_kasbon_auto_reservations"))return result(holds);
    if(normalized.startsWith("UPDATE public.payroll_items")){
      const item=items.find(i=>i.id===args[3]&&i.kasbon_deduction===args[5]);
      if(!item)return result([]);
      item.kasbon_deduction=args[0];item.total_deductions=args[1];item.net_salary=args[2];
      return result([{id:item.id}]);
    }
    if(normalized.startsWith("INSERT INTO public.payroll_kasbon_auto_reservations")){
      onInsert();
      const [companyId,runId,employeeId,itemId,advanceId,period,amount,balance]=args;
      holds.push({id:400+holds.length,companyId,runId,employeeId,
        payrollItemId:itemId,advanceId,period,amount,balanceAtPreparation:balance,state:"prepared"});
      return result([{id:holds.at(-1)!.id}]);
    }
    if(normalized.includes("SELECT status,approved_at,accounting_entry_id"))return result([run]);
    throw Error("UNKNOWN_SQL_FIXTURE: "+normalized.slice(0,110));
  },release:()=>{released++;}} as unknown as PoolClient;
  const pool={connect:async()=>client};
  return {pool,run,plans,advance,calls,get items(){return items;},get holds(){return holds;},
    get released(){return released;},setRole:(value:string)=>{currentUser=value;},
    setKasbonPrivilege:(value:boolean)=>{canKasbon=value;},
    setEmployees:(value:{id:number}[])=>{active=value;},
    failInsert:()=>{onInsert=()=>{throw Error("SIMULATED_INSERT_FAILURE");};},
    ambiguousCommit:()=>{onCommit=()=>{throw Object.assign(Error("SIMULATED_COMMIT_UNKNOWN"),{code:"ECONNRESET"});};}};
}

describe("Payroll Calculate transaction contract (no external DB)",()=>{
  beforeEach(()=>{vi.stubEnv("APP_ENV","development");vi.stubEnv("PAYROLL_DEV_CALCULATE_ENABLED","true");});
  afterEach(()=>vi.unstubAllEnvs());
  it("calculates a prepared installment without approving, posting or paying",async()=>{
    const x=fixture();
    const r=await calculateDevPayroll(x.pool,1,32);
    expect(r).toMatchObject({status:"draft",period:"2026-11-01",
      preparedReservations:1,updatedItems:1,net:"2900.00",
      approved:false,accountingPosted:false,salaryPaid:false});
    expect(x.run.status).toBe("draft");
    expect(x.items[0].kasbon_deduction).toBe("100.00");
    expect(x.holds).toHaveLength(1);
    expect(x.holds[0]).toMatchObject({advanceId:801,amount:"100.00",state:"prepared"});
    expect(x.calls.filter(q=>/^UPDATE public.cash_advances|INSERT INTO public.accounting_entries|INSERT INTO public.salary_payments/i.test(q))).toHaveLength(0);
    expect(x.calls.at(-1)).toBe("COMMIT");
    expect(x.released).toBe(1);
  });
  it("repeat Calculate reuses same exact hold without duplicate deduction",async()=>{
    const x=fixture();
    const first=await calculateDevPayroll(x.pool,1,32);
    const next=await calculateDevPayroll(x.pool,1,32);
    expect(first.preparedReservations).toBe(1);
    expect(next).toMatchObject({preparedReservations:0,updatedItems:0,net:"2900.00"});
    expect(x.holds).toHaveLength(1);
  });
  it("FULL chooses remaining balance only",async()=>{
    const x=fixture({choice:"FULL"});
    const r=await calculateDevPayroll(x.pool,1,32);
    expect(r.net).toBe("2500.00");
    expect(x.holds[0].amount).toBe("500.00");
  });
  it("no cash advance is a valid zero deduction rather than fabricated loan",async()=>{
    const x=fixture({loan:false});
    const r=await calculateDevPayroll(x.pool,1,32);
    expect(r).toMatchObject({preparedReservations:0,updatedItems:0,net:"3000.00"});
    expect(x.holds).toHaveLength(0);
  });
  it("never runs without restricted writer identity/column privilege",async()=>{
    const x=fixture();
    x.setKasbonPrivilege(false);
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_DEDICATED_ROLE_NOT_READY");
    expect(x.calls.at(-1)).toBe("ROLLBACK");
    expect(x.holds).toHaveLength(0);
    x.setKasbonPrivilege(true);x.setRole("postgres");
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_DEDICATED_ROLE_NOT_READY");
    expect(x.holds).toHaveLength(0);
  });
  it("rejects incomplete or cross-company roster before any mutation",async()=>{
    const x=fixture();
    x.setEmployees([{id:101},{id:102}]);
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_ROSTER_NOT_READY");
    expect(x.holds).toHaveLength(0);
    x.setEmployees([{id:101}]);x.items[0].employee_company=3;
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_ROSTER_NOT_READY");
    expect(x.calls.at(-1)).toBe("ROLLBACK");
  });
  it("rejects unapproved source and missing plan",async()=>{
    const x=fixture({eligible:false});
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_PLAN_OR_ADVANCE_NOT_READY");
    expect(x.holds).toHaveLength(0);
    const y=fixture();y.plans.length=0;
    await expect(calculateDevPayroll(y.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_PLAN_OR_ADVANCE_NOT_READY");
  });
  it("rejects non-Draft and keeps it unchanged",async()=>{
    const x=fixture();x.run.status="reviewed";
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_RUN_NOT_CLEAN_DRAFT");
    expect(x.run.status).toBe("reviewed");expect(x.holds).toHaveLength(0);
  });
  it("rolls back changed item if reservation insert fails",async()=>{
    const x=fixture();x.failInsert();
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("SIMULATED_INSERT_FAILURE");
    expect(x.items[0].kasbon_deduction).toBe("0.00");
    expect(x.items[0].net_salary).toBe("3000.00");
    expect(x.holds).toHaveLength(0);
    expect(x.calls.at(-1)).toBe("ROLLBACK");
  });
  it("rejects a kasbon deduction exceeding the employee gross salary",async()=>{
    const x=fixture();x.items[0].base_salary="50.00";x.items[0].gross_salary="50.00";
    x.items[0].net_salary="50.00";
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_DEDUCTIONS_EXCEED_GROSS");
    expect(x.calls.at(-1)).toBe("ROLLBACK");expect(x.holds).toHaveLength(0);
  });
  it("never replays an ambiguous COMMIT transport error",async()=>{
    const x=fixture();x.ambiguousCommit();
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("SIMULATED_COMMIT_UNKNOWN");
    expect(x.calls.filter(q=>q.startsWith("BEGIN "))).toHaveLength(1);
  });
  it("requires development opt-in and never opens a pool in PROD",async()=>{
    const x=fixture();vi.stubEnv("APP_ENV","production");
    await expect(calculateDevPayroll(x.pool,1,32)).rejects.toThrow("PAYROLL_CALCULATE_DEV_DISABLED");
    expect(x.calls).toHaveLength(0);
  });
});
