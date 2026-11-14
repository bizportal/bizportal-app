import { pool } from "@workspace/db";
import type { PoolClient } from "pg";

/**
 * Stage-one HRD reader: no financial or employee/document writes.
 * Uses the legacy PROD HRD role and RLS company scope, but deliberately
 * strengthens the transaction to BEGIN READ ONLY.
 * This does NOT replace the existing HRD writer implementation.
 */
export async function withHrdCompanyReadOnly<T>(
  companyId: number,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw Error("HRD_READONLY_INVALID_COMPANY");
  }
  const client = await pool.connect();
  let inTransaction = false;
  let discardClient: Error | undefined;
  try {
    await client.query("BEGIN READ ONLY");
    inTransaction = true;
    await client.query("SET LOCAL ROLE bizportal_hrd_prod");
    await client.query("SELECT set_config('app.hrd_company_id',$1,true)", [String(companyId)]);
    const scope = await client.query(
      "SELECT current_user AS role, current_setting('app.hrd_company_id',true) AS company",
    );
    if (scope.rowCount !== 1 ||
        scope.rows[0]?.role !== "bizportal_hrd_prod" ||
        scope.rows[0]?.company !== String(companyId)) {
      throw Error("HRD_READONLY_ROLE_SCOPE_MISMATCH");
    }
    const result = await work(client);
    await client.query("COMMIT");
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); }
      catch { discardClient = Error("HRD_READONLY_ROLLBACK_UNCONFIRMED"); }
    }
    throw error;
  } finally {
    // A failed rollback leaves session role/transaction state unknown. Never
    // return that connection to the shared BizPortal pool.
    client.release(discardClient);
  }
}
