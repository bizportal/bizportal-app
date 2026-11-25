/** Only bundled into the disposable PO14 worker, never into the API runtime. */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../lib/db/src/schema/index";
export * from "../../../lib/db/src/schema/index";

export let pool: pg.Pool;
export let db: ReturnType<typeof drizzle<typeof schema>>;
const postCommitCallbacks: Array<() => Promise<void>> = [];

export function configureIsolatedWorkerDatabase(databaseName: string) {
  if (pool || !/^po14_bank_ingestion_qa_[a-f0-9]{12}$/.test(databaseName)) {
    throw new Error("QA_DATABASE_BINDING_INVALID");
  }
  pool = new pg.Pool({
    connectionString: `postgres://postgres@127.0.0.1:55495/${databaseName}`,
    application_name: "po14-isolated-real-sql-worker",
    max: 3, connectionTimeoutMillis: 4000, query_timeout: 10000,
    statement_timeout: 10000, idleTimeoutMillis: 1000,
  });
  db = drizzle(pool, { schema });
}

export function onMarketplaceFinanceCommit(scopedDb: unknown, callback: () => Promise<void>) {
  if (scopedDb !== db) throw new Error("QA_POST_COMMIT_SCOPE_INVALID");
  postCommitCallbacks.push(callback);
}

export async function flushQaPostCommitCallbacks() {
  while (postCommitCallbacks.length) await postCommitCallbacks.shift()!();
}

export function getRuntimeDatabaseUrl(): never {
  throw new Error("BUSINESS_DATABASE_FORBIDDEN_IN_PO14_WORKER");
}
export const getDatabaseUrl = getRuntimeDatabaseUrl;
export const resolveDatabaseUrl = getRuntimeDatabaseUrl;
export const readSecret = getRuntimeDatabaseUrl;
export const withMarketplaceFinanceDevTransaction = getRuntimeDatabaseUrl;
export const withMarketplaceFinanceDevReadOnlyTransaction = getRuntimeDatabaseUrl;
