import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../routes/bank-reconciliation.ts", import.meta.url), "utf8");

function route(start: string, next: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(next, a + start.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe("QRIS/Bank Reconciliation mutation route static safety contract", () => {
  it("does not enter canonical QRIS preparation without verified actor and rolls back on failure", () => {
    const body = route(
      'router.post("/bank-reconciliation/:mutationId/qris-canonical/prepare"',
      'router.patch("/bank-reconciliation/qris-candidates/payments/:paymentId/date"',
    );
    expect(body.indexOf("getApprovalActor(req)")).toBeLessThan(body.indexOf("pool.connect()"));
    expect(body).toContain('res.status(401).json({ error: "Unauthorized" })');
    expect(body).toContain('await client.query("begin")');
    expect(body).toContain('await client.query("commit")');
    expect(body).toContain('await client.query("rollback")');
    expect(body).toContain("client.release()");
  });

  it("checks QRIS payment-date input and user company scope before updates", () => {
    const body = route(
      'router.patch("/bank-reconciliation/qris-candidates/payments/:paymentId/date"',
      'router.',
    );
    expect(body).toContain("INVALID_PAYMENT_DATE");
    expect(body).toContain("COMPANY_CONTEXT_MISMATCH");
    expect(body).toContain("getApprovalActor(req)");
    expect(body).toContain("actor.companyId");
  });

  it("rejects vendor batch empty/duplicate allocation and requires actor before transaction", () => {
    const index = source.indexOf('router.post("/bank-reconciliation/:mutationId/vendor-invoice-payment-batch"');
    expect(index).toBeGreaterThanOrEqual(0);
    const body = source.slice(index, index + 4800);
    expect(body).toContain("getApprovalActor(req)");
    expect(body).toContain("vendor_invoice_ids");
    expect(body).toContain("requestedAllocationByInvoice.has(invoiceId)");
    expect(body.indexOf("getApprovalActor(req)")).toBeLessThan(body.indexOf("pool.connect()"));
    expect(body).toContain("if (!actor)");
  });

  it("documents the currently broad reconciliation actor roles for separate permission review", () => {
    const start = source.indexOf("async function getApprovalActor");
    expect(start).toBeGreaterThanOrEqual(0);
    const actor = source.slice(start, start + 900);
    for (const role of ["admin", "owner", "finance", "accounting", "accountant", "super_admin"]) {
      expect(actor).toContain(`"${role}"`);
    }
    // This is a characterization test, NOT approval to enable these roles.
  });
});
