import { describe, expect, it } from "vitest";
import { verifyKasbonReviewLedger } from "./payroll-kasbon-hr-review-guard";

type Reservation = {
  payrollItemId: unknown; employeeId: unknown; amount: unknown;
  heldBalance: unknown; currentBalance: unknown;
  advanceStatus: unknown; advanceLifecycle: unknown;
  advanceApprovedAt: unknown; advanceApprovedBy: unknown;
  advanceDisbursedAt: unknown; advanceDisbursedBy: unknown;
  advanceAccountingEntryId: unknown; advancePostingStatus: unknown;
  advanceVoidedAt: unknown; state: unknown;
};
const item=(amount:string)=>({id:4,employee_id:51,kasbon_deduction:amount});
const hold:Reservation={
  payrollItemId:4,employeeId:51,amount:"500.00",heldBalance:"1500.00",
  currentBalance:"1500.00",advanceStatus:"partial",
  advanceLifecycle:"partially_settled",advanceApprovedAt:"2026-10-01",
  advanceApprovedBy:"super-admin",advanceDisbursedAt:"2026-10-02",
  advanceDisbursedBy:"finance",advanceAccountingEntryId:9001,
  advancePostingStatus:"posted",advanceVoidedAt:null,state:"prepared",
};
describe("Kasbon approval review scoped ledger contract, source-only",()=>{
  it("uses only server-scoped company and run arguments with SELECT query",async()=>{
    const calls: Array<{sql:string;params:unknown[]}>=[];
    const query=async(sql:string,params:unknown[])=>{
      calls.push({sql,params});return {rows:[hold]};
    };
    expect(await verifyKasbonReviewLedger(query,1,32,[item("500.00")])).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([1,32]);
    expect(calls[0].sql).toContain("r.company_id=$1 AND r.run_id=$2");
    expect(calls[0].sql).toContain("a.company_id=r.company_id");
    expect(calls[0].sql).toContain("a.employee_id=r.employee_id");
    expect(calls[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  });
  it("queries even zero-deduction items and rejects hidden reserved loans",async()=>{
    let n=0;
    const query=async(_sql:string,_params:unknown[])=>{
      n++;return {rows:[hold]};
    };
    expect(await verifyKasbonReviewLedger(query,1,32,[item("0.00")])).toBe(false);
    expect(n).toBe(1);
  });
  it("fails closed when persisted balance changes or a reservation disappears",async()=>{
    const changed=async(_sql:string,_params:unknown[])=>({
      rows:[{...hold,currentBalance:"1400.00"}],
    });
    const missing=async(_sql:string,_params:unknown[])=>({rows:[] as Reservation[]});
    expect(await verifyKasbonReviewLedger(changed,1,32,[item("500.00")])).toBe(false);
    expect(await verifyKasbonReviewLedger(missing,1,32,[item("500.00")])).toBe(false);
  });
  it("does not interpret a receipt parser as an authenticated approval",async()=>{
    // Reserved for the actual approval HTTP gate: this helper returns Boolean
    // *only* for ledger integrity, not Super Admin identity or permission.
    const query=async(_sql:string,_params:unknown[])=>({rows:[hold]});
    const result=await verifyKasbonReviewLedger(query,1,32,[item("500.00")]);
    expect(result).toBe(true);
    expect(typeof result).toBe("boolean");
  });
});
