import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const apiSource = readFileSync(fileURLToPath(new URL("../routes/purchase-workflow.ts", import.meta.url)), "utf8");
const uiSource = readFileSync(fileURLToPath(new URL("../../../bizportal/src/pages/purchase/vendor-invoices.tsx", import.meta.url)), "utf8");

describe("posted supplier disbursement visibility before final bank reconciliation", () => {
  it("keeps the reconciled AP paid balance separate from posted disbursement amounts", () => {
    expect(apiSource).toContain("coalesce(rvip.paid_amount, 0) reconciled_amount_paid");
    expect(apiSource).toContain("coalesce(posted_disbursement.amount, 0) posted_disbursement_amount");
    expect(apiSource).toContain("postedDisbursementAmount: Number(row.posted_disbursement_amount)");
  });

  it("counts only active posted supplier payments for the same invoice and company", () => {
    expect(apiSource).toContain("bdi.vendor_invoice_id = vi.id");
    expect(apiSource).toContain("bdi.transaction_type = 'supplier_payment'");
    expect(apiSource).toContain("bd.company_id = vi.company_id");
    expect(apiSource).toContain("bd.status = 'posted'");
    expect(apiSource).toContain("bd.void_entry_id is null");
  });

  it("hides Pay and marks posted disbursement as pending bank reconciliation", () => {
    expect(uiSource).toContain("Number(vi.postedDisbursementAmount ?? 0) <= 0");
    expect(uiSource).toContain("menunggu rekonsiliasi bank");
  });
});
