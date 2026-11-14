// Export your models here. Add one export per file
// export * from "./posts";
//
// Each model/table should ideally be split into different files.
// Each model/table should define a Drizzle table, insert schema, and types:
//
//   import { pgTable, text, serial } from "drizzle-orm/pg-core";
//   import { createInsertSchema } from "drizzle-zod";
//   import { z } from "zod/v4";
//
//   export const postsTable = pgTable("posts", {
//     id: serial("id").primaryKey(),
//     title: text("title").notNull(),
//   });
//
//   export const insertPostSchema = createInsertSchema(postsTable).omit({ id: true });
//   export type InsertPost = z.infer<typeof insertPostSchema>;
//   export type Post = typeof postsTable.$inferSelect;

export {}
// Preserve standalone exports, restore only canonical Marketplace models used by unchanged services.
export { mktAccountingHandoffsTable } from "./mktAccountingHandoffs";
export { mktApPreparationsTable } from "./mktApPreparations";
export { mktPoGoodsReceiptItemsTable } from "./mktPoGoodsReceiptItems";
export { mktPoGoodsReceiptsTable } from "./mktPoGoodsReceipts";
export { mktPoShipmentEventsTable } from "./mktPoShipmentEvents";
export { mktPoShipmentItemsTable } from "./mktPoShipmentItems";
export { mktPoShipmentsTable } from "./mktPoShipments";
export { mktPurchaseOrderLinesTable } from "./mktPurchaseOrderLines";
export { mktPurchaseOrdersTable } from "./mktPurchaseOrders";
export { paymentRequestItemsTable } from "./purchaseWorkflow";
export { paymentRequestsTable } from "./purchaseWorkflow";
export { suppliersTable } from "./suppliers";
export { vendorInvoiceLinesTable } from "./purchaseWorkflow";
export { vendorInvoicesTable } from "./purchaseWorkflow";
export { vendorNotificationsTable } from "./vendorNotifications";
