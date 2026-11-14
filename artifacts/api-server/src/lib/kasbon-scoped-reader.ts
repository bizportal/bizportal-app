/**
 * Unmounted, production-only Kasbon reader isolation contract.
 * No route, pool selection, credentials or schema migration is introduced here.
 * The caller supplies a fresh DB client obtained from an independently verified
 * connection. Never pass this helper an untrusted actor/company identifier.
 */
export type KasbonScopedQueryResult = {
  rowCount: number | null;
  rows: Record<string, unknown>[];
};
export interface KasbonScopedClient {
  query(sql: string, values?: unknown[]): Promise<KasbonScopedQueryResult>;
  release(): void;
}

const ROLE = "bizportal_payroll_prod";

export async function withScopedKasbonReadOnly<T>(
  client: KasbonScopedClient,
  companyId: number,
  read: (client: KasbonScopedClient) => Promise<T>,
): Promise<T> {
  let begun = false;
  try {
    if (!Number.isSafeInteger(companyId) || companyId <= 0) {
      throw Error("KASBON_COMPANY_SCOPE_INVALID");
    }
    if (process.env.APP_ENV?.trim().toLowerCase() !== "production") {
      throw Error("KASBON_READER_PROD_ONLY");
    }
    await client.query("BEGIN READ ONLY");
    begun = true;
    await client.query(`SET LOCAL ROLE ${ROLE}`);
    await client.query("SELECT set_config('app.payroll_company_id', $1, true)", [String(companyId)]);
    const identity = await client.query(
      "SELECT current_user AS role, current_setting('app.payroll_company_id',true) AS company, current_setting('transaction_read_only') AS read_only",
    );
    const row = identity.rowCount === 1 ? identity.rows[0] : null;
    if (row?.role !== ROLE || row?.company !== String(companyId) || row?.read_only !== "on") {
      throw Error("KASBON_READER_IDENTITY_SCOPE_INVALID");
    }
    const result = await read(client);
    await client.query("COMMIT");
    begun = false;
    return result;
  } catch (error) {
    if (begun) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
