import { describe, expect, it } from "vitest";
import pg from "pg";
import { isIssue292ScopedFinanceSession } from "../lib/reconciliation/issue292FinancePrincipalGate";

const url = process.env.QRIS292_ISOLATED_PG_URL;

describe.skipIf(!url)("Issue #292 database finance principal is fail-closed", () => {
  it("rejects an admin connection and a forged SET ROLE tuple", async () => {
    const client = new pg.Client({connectionString:url});
    await client.connect();
    await client.query("BEGIN");
    try {
      const admin = await client.query<{current_user:string;session_user:string}>(
        "SELECT current_user,session_user",
      );
      expect(admin.rows[0].current_user).toBe("postgres");
      expect(admin.rows[0].session_user).toBe("postgres");
      expect(await isIssue292ScopedFinanceSession(client)).toBe(false);

      // Exercise real PostgreSQL identity semantics, not an injected JS mock.
      // Role is temporary and transaction is always rolled back.
      await client.query("CREATE ROLE sport_center_app NOLOGIN");
      await client.query("SET LOCAL ROLE sport_center_app");
      const switched=await client.query<{current_user:string;session_user:string}>(
        "SELECT current_user,session_user",
      );
      expect(switched.rows[0]).toEqual({
        current_user:"sport_center_app",
        session_user:"postgres",
      });
      expect(await isIssue292ScopedFinanceSession(client)).toBe(false);
    } finally {
      await client.query("ROLLBACK").catch(()=>undefined);
      await client.end();
    }
    const check=new pg.Client({connectionString:url});
    await check.connect();
    try {
      const role=await check.query<{n:number}>(`
        SELECT count(*)::int AS n FROM pg_roles
        WHERE rolname='sport_center_app'
      `);
      expect(role.rows[0].n).toBe(0);
    } finally {await check.end();}
  });
});
