import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PAYROLL_SETTLEMENT_TABLES, verifyPayrollSettlementRuntime } from "./payroll-accounting-runtime-preflight";

function fixture() {
  const identity = { actor: "bizportal_payroll_settlement_dev", login: "bizportal_payroll_settlement_dev",
    rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false,
    rolreplication: false, read_only: "on", isolation: "repeatable read", schema_create: false,
    alternate_role: false, payout_write: false };
  const rows = PAYROLL_SETTLEMENT_TABLES.map(t => ({ name: t.table as string, table_present: true,
    rls_enabled: true, owns_table: false, can_select: true, broad_update: false, destructive: false,
    insert_columns: true, update_columns: true, forbidden_update: false, sequence_access: true,
    select_policy: true, insert_policy: true, update_policy: true }));
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT current_user")) return { rows: [identity] };
    if (sql.includes("WITH contract AS")) return { rows };
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  return { identity, rows, query, release, connect, pool: { connect } as unknown as Pick<Pool,"connect"> };
}

beforeEach(() => vi.stubEnv("APP_ENV","development"));
afterEach(() => vi.unstubAllEnvs());
describe("Payroll runtime structural preflight (no financial writes)", () => {
  it("checks metadata in READ ONLY and rolls back before readiness is returned", async () => {
    const f=fixture();
    expect(await verifyPayrollSettlementRuntime(f.pool)).toEqual({ structuralChecksPassed:true,
      checkedTables:18,readOnly:true,runtimePostingTested:false,policySemanticsVerified:false });
    expect(f.query.mock.calls[0]![0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(f.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(f.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|REVOKE|SET ROLE|COMMIT)\b/i.test(sql))).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("does not connect outside DEV", async () => {
    const f=fixture();vi.stubEnv("APP_ENV","production");
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("DEV_ONLY");
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(["actor","login"] as const)("refuses substituted %s identity",async field=>{
    const f=fixture();f.identity[field]="postgres";
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("PREFLIGHT_REJECTED");
    expect(f.query.mock.calls.some(([q])=>q.includes("WITH contract AS"))).toBe(false);
    expect(f.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  });
  it.each(["rolsuper","rolbypassrls","rolcreaterole","rolcreatedb","rolreplication",
    "schema_create","alternate_role","payout_write"] as const)("refuses extra capability %s",async field=>{
    const f=fixture();f.identity[field]=true;
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("PREFLIGHT_REJECTED");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it.each(["table_present","rls_enabled","can_select","insert_columns","update_columns",
    "sequence_access","select_policy","insert_policy","update_policy"] as const)("rejects missing %s",async field=>{
    const f=fixture();f.rows[0]![field]=false;
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("PREFLIGHT_REJECTED");
    expect(f.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
  });
  it.each(["owns_table","broad_update","destructive","forbidden_update"] as const)("rejects unsafe %s",async field=>{
    const f=fixture();f.rows[0]![field]=true;
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("PREFLIGHT_REJECTED");
  });
  it.each(["missing","duplicate","unexpected"])("rejects %s metadata rows", async type=>{
    const f=fixture();
    if(type==="missing")f.rows.pop();
    else if(type==="duplicate")f.rows[1]={...f.rows[0]!};
    else f.rows[0]!.name="another_table";
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("PREFLIGHT_REJECTED");
  });
  it("rejects a session that is not read-only", async()=>{
    const f=fixture();f.identity.read_only="off";
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("PREFLIGHT_REJECTED");
  });
  it("rejects NOLOGIN or an unexpected transaction snapshot", async()=>{
    const f=fixture();f.identity.rolcanlogin=false;
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("PREFLIGHT_REJECTED");
    f.identity.rolcanlogin=true;f.identity.isolation="read committed";
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow("PREFLIGHT_REJECTED");
  });
  it("redacts connection failure without querying or releasing an unacquired connection", async()=>{
    const f=fixture();f.connect.mockRejectedValueOnce(Error("postgresql://secret:password@invalid.test"));
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow(/^PAYROLL_RUNTIME_PREFLIGHT_REJECTED$/);
    expect(f.query).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
  });
  it("redacts SQL failure and returns the borrowed connection", async()=>{
    const f=fixture();f.query.mockRejectedValueOnce(Error("postgresql://secret:password@invalid.test"));
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow(/^PAYROLL_RUNTIME_PREFLIGHT_REJECTED$/);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("discards a connection when rollback fails",async()=>{
    const f=fixture();f.query.mockRejectedValue(Error("synthetic broken connection"));
    await expect(verifyPayrollSettlementRuntime(f.pool)).rejects.toThrow(/^PAYROLL_RUNTIME_PREFLIGHT_REJECTED$/);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message:"PAYROLL_RUNTIME_PREFLIGHT_ROLLBACK_FAILED"}));
  });
});
