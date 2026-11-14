import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { connect: vi.fn() },
}));

import { pool } from "@workspace/db";
import { importGmailInvoiceCandidate } from "../lib/gmail-invoice-candidates";

describe("Gmail import transactional safeguard for historical payment-slip candidates", () => {
  it("rejects an older ready payment-slip candidate before creating Vendor AP or any journal", async () => {
    const client = {
      query: vi.fn(async (statement: string) => {
        if (/from public\.gmail_invoice_candidates/.test(statement)) {
          return {
            rows: [{
              id: 4,
              company_id: 1,
              subject: "Payment slip PT Cahaya Sejati Teknologi",
              status: "ready",
              extraction_status: "complete",
              vendor_invoice_id: null,
              extracted_vendor_name: "PT Cahaya Sejati Teknologi",
              extracted_invoice_number: "SYNTHETIC-INV-1",
              extracted_total: "10000",
              extracted_confidence: "0.99",
            }],
          };
        }
        if (statement === "begin" || statement === "rollback") return { rows: [] };
        throw new Error(`Unexpected SQL for payment evidence: ${statement.slice(0, 60)}`);
      }),
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);

    await expect(importGmailInvoiceCandidate({
      companyId: 1,
      candidateId: 4,
      actorEmail: "finance@example.invalid",
    })).rejects.toMatchObject({
      status: 409,
      code: "GMAIL_PAYMENT_EVIDENCE_NOT_PAYABLE",
    });

    const sql = client.query.mock.calls.map(([statement]) => statement.toLowerCase());
    expect(sql).toHaveLength(3);
    expect(sql).toContain("begin");
    expect(sql).toContain("rollback");
    expect(sql.join(" ")).not.toMatch(/insert\s+into\s+(?:public\.)?(?:vendor_invoices|vendor_invoice_lines|accounting_entries)/);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
