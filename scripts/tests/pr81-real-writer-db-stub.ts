/** Disposable-test-only DB injection. No Supabase/GCP host or secret support. */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../lib/db/src/schema";
const raw = process.env.PR81_DISPOSABLE_PG_URL || "";
const url = new URL(raw);
if (process.env.PR81_DISPOSABLE_SERVICE_E2E !== "true" ||
    url.hostname !== "pr81pg" || url.port !== "5432" ||
    url.pathname !== "/cst_pr81_writer_ci" || url.username !== "postgres" ||
    url.password !== "synthetic-only" ||
    url.protocol !== "postgresql:" || url.search || url.hash) {
  throw new Error("REFUSE_ANY_NON_DISPOSABLE_SERVICE_DATABASE");
}
export const pool = new pg.Pool({
 connectionString:raw,max:1,ssl:false,connectionTimeoutMillis:3000,
 application_name:"pr81-disposable-service-only"
});
export const db = drizzle(pool,{schema});
export {
 mktApPreparationsTable,mktAccountingHandoffsTable,paymentRequestsTable,
 mktPoGoodsReceiptsTable,mktPoShipmentsTable,mktPurchaseOrdersTable,
 vendorInvoicesTable,
} from "../../lib/db/src/schema";
export const afterCommitActions: Array<() => void | Promise<void>> = [];
/** The outer DB transaction is deliberately rolled back; NEVER publish callbacks. */
export function onMarketplaceFinanceCommit(_session:object,action:()=>void|Promise<void>):void {
 afterCommitActions.push(action);
}
