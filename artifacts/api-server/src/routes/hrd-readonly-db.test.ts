import { beforeEach, describe, expect, it, vi } from "vitest";

const state=vi.hoisted(()=>({
  calls:[] as Array<{sql:string;values:unknown[]|undefined}>,
  role:"bizportal_hrd_prod",company:"1",workFailure:false,
  connected:0,released:0,
}));
vi.mock("@workspace/db",()=>({
  pool:{
    connect:async()=>{
      state.connected++;
      return {
        query:async(sql:string,values?:unknown[])=>{
          state.calls.push({sql,values});
          if(sql.startsWith("SELECT current_user"))return{
            rowCount:1,rows:[{role:state.role,company:state.company}],
          };
          if(sql.startsWith("SELECT id FROM") && state.workFailure)
            throw Error("SENSITIVE_DB_FAILURE");
          return{rowCount:0,rows:[]};
        },
        release:()=>{state.released++},
      };
    },
  },
}));
import { withHrdCompanyReadOnly } from "./hrd-readonly-db";
describe("HRD read-only transaction custody",()=>{
  beforeEach(()=>{
    state.calls.length=0;state.connected=0;state.released=0;
    state.role="bizportal_hrd_prod";state.company="1";state.workFailure=false;
  });
  const read=()=>withHrdCompanyReadOnly(1,client=>
    client.query("SELECT id FROM public.employees WHERE company_id=$1 LIMIT 1",[1]));
  it("enforces BEGIN READ ONLY, scoped role and transaction-local company",async()=>{
    await read();
    expect(state.calls.map(v=>v.sql)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL ROLE bizportal_hrd_prod",
      "SELECT set_config('app.hrd_company_id',$1,true)",
      "SELECT current_user AS role, current_setting('app.hrd_company_id',true) AS company",
      "SELECT id FROM public.employees WHERE company_id=$1 LIMIT 1",
      "COMMIT",
    ]);
    expect(state.calls[2].values).toEqual(["1"]);
    expect(state.connected).toBe(1);expect(state.released).toBe(1);
  });
  it("rejects invalid company without acquiring a pooled connection",async()=>{
    await expect(withHrdCompanyReadOnly(0,async()=>true)).rejects.toThrow("HRD_READONLY_INVALID_COMPANY");
    expect(state.connected).toBe(0);
  });
  it("fails closed on role mismatch and rolls back",async()=>{
    state.role="postgres";
    await expect(read()).rejects.toThrow("HRD_READONLY_ROLE_SCOPE_MISMATCH");
    expect(state.calls.map(v=>v.sql)).toContain("ROLLBACK");
    expect(state.calls.map(v=>v.sql)).not.toContain("COMMIT");
    expect(state.released).toBe(1);
  });
  it("fails closed on tenant mismatch and rolls back",async()=>{
    state.company="2";
    await expect(read()).rejects.toThrow("HRD_READONLY_ROLE_SCOPE_MISMATCH");
    expect(state.calls.map(v=>v.sql)).toContain("ROLLBACK");
    expect(state.released).toBe(1);
  });
  it("rolls back query failures and releases the client",async()=>{
    state.workFailure=true;
    await expect(read()).rejects.toThrow("SENSITIVE_DB_FAILURE");
    expect(state.calls.map(v=>v.sql)).toContain("ROLLBACK");
    expect(state.calls.map(v=>v.sql)).not.toContain("COMMIT");
    expect(state.released).toBe(1);
  });
});
