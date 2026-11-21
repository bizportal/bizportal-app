import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { insertSalesDocumentSchema } from "../../../../lib/db/src/schema/salesDocuments";

describe("Sales Order customer identity guard", () => {
  const base = { kind: "order" as const, customerName: "PT Customer", totalAmount: "100", taxAmount: "11", grandTotal: "111" };
  it("rejects a new order without customerId even when name exists", () => {
    expect(insertSalesDocumentSchema.safeParse({ ...base, customerId: null }).success).toBe(false);
    expect(insertSalesDocumentSchema.safeParse({ ...base }).success).toBe(false);
  });
  it("rejects nonpositive or invalid customer ids", () => {
    expect(insertSalesDocumentSchema.safeParse({ ...base, customerId: 0 }).success).toBe(false);
    expect(insertSalesDocumentSchema.safeParse({ ...base, customerId: -1 }).success).toBe(false);
  });
  it("accepts the identity shape of an order with a valid registered customer id", () => {
    expect(insertSalesDocumentSchema.safeParse({ ...base, customerId: 24 }).success).toBe(true);
  });
  it("preserves draft quotation without customerId", () => {
    expect(insertSalesDocumentSchema.safeParse({ ...base, kind: "quote", customerId: null }).success).toBe(true);
  });
});

describe("CST-DEV database customer guard migration contract", () => {
  const migration = readFileSync(
    new URL("../../../../scripts/sql/20261121_sales_order_customer_required_dev_review.sql", import.meta.url),
    "utf8",
  );
  it("requires customer and company match for new or reidentified Sales Orders", () => {
    expect(migration).toContain("CREATE TRIGGER sales_order_customer_company_guard_dev_trigger");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OF kind, customer_id, company_id");
    expect(migration).toContain("c.id = NEW.customer_id");
    expect(migration).toContain("c.company_id = NEW.company_id");
    expect(migration).toContain("ERRCODE='23514'");
  });
  it("does not block unrelated legacy order status or invoice-status updates", () => {
    const triggerClause = migration.match(/BEFORE INSERT OR UPDATE OF ([^\\n]+)/)?.[1] ?? "";
    expect(triggerClause).not.toContain("status");
    expect(triggerClause).not.toContain("invoice_status");
    expect(migration).not.toContain("UPDATE OF kind, customer_id, company_id, status");
  });
});
