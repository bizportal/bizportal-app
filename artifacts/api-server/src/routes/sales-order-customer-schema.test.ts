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
