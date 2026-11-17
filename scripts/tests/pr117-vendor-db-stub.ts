/** Disposable PR117 integration: no live database or Secret Manager access. */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../lib/db/src/schema";

const raw = process.env.PR117_DISPOSABLE_PG_URL ?? "";
const endpoint = new URL(raw);
if (
  process.env.PR117_DISPOSABLE_INTEGRATION !== "true" ||
  endpoint.protocol !== "postgresql:" ||
  endpoint.hostname !== "pr117pg" ||
  endpoint.port !== "5432" ||
  endpoint.pathname !== "/cst_pr107_ci" ||
  endpoint.username !== "bizportal_finance_cst_login_dev" ||
  endpoint.password !== "synthetic-cst-only" ||
  endpoint.search !== "" ||
  endpoint.hash !== ""
) {
  throw Error("PR117_REFUSE_ANY_LIVE_FINANCE_DATABASE");
}
export const pool = new pg.Pool({
  connectionString: raw,
  ssl: false,
  max: 2,
  connectionTimeoutMillis: 3000,
  application_name: "pr117-isolated-canonical-finance-service",
});
export const db = drizzle(pool, { schema });
export const callbacks: Array<() => void | Promise<void>> = [];
export function onMarketplaceFinanceCommit(_session: object, callback: () => void | Promise<void>) {
  // Never publish: all synthetic writer transactions intentionally roll back.
  callbacks.push(callback);
}
export {
  mktPurchaseOrdersTable,
  mktPurchaseOrderLinesTable,
  mktPoShipmentsTable,
  mktPoShipmentItemsTable,
  mktPoGoodsReceiptsTable,
  mktPoGoodsReceiptItemsTable,
  vendorInvoicesTable,
  vendorInvoiceLinesTable,
  mktApPreparationsTable,
  paymentRequestsTable,
  mktAccountingHandoffsTable,
} from "../../lib/db/src/schema";
