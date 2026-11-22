import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/routes/purchase-workflow.ts"), "utf8");
const start = source.indexOf('router.get("/purchase-workflow/vendor-invoices/:id"');
const end = source.indexOf('router.post("/purchase-workflow/vendor-invoices/:id/reset-payment"', start);
const route = source.slice(start, end);

describe("Vendor AP DEV schema-compatible reversal evidence", () => {
  it("derives reversal from canonical accounting_entries rather than an absent vendor column", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(route).toContain("invoice_reversal.reversal_journal_id");
    expect(route).toContain("left join lateral (");
    expect(route).toContain("from public.accounting_entries rev");
    expect(route).toContain("rev.company_id = vi.company_id");
    expect(route).toContain("rev.source_id = vi.journal_entry_id");
    expect(route).toContain("rev.source::text = 'reversal'");
    expect(route).toContain("rev.status::text = 'posted'");
    expect(route).not.toContain("vi.reversal_journal_id");
  });
  it("never counts reversed or orphan payment evidence as paid", () => {
    expect(route).toContain("amountPaid: row.reconciled_amount_paid");
    expect(route).toContain("orphanDisbursementNumbers: row.orphan_disbursement_numbers");
    expect(route).toContain("linkedVoidedDisbursementNumbers: row.linked_voided_disbursement_numbers");
    expect(route).toContain("where vi.id = $2 and vi.company_id = $1");
    expect(route).not.toContain("amountPaid: row.orphan_disbursement_numbers");
  });
});
