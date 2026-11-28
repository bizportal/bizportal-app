import { describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  assertVendorDisbursementMayPost,
  VendorDisbursementRepeatError,
} from "./vendorDisbursementRepeatGuard";

type Fixture = {
  company?: number;
  status?: string;
  gross?: string;
  legacyPaid?: string;
  posted?: string;
  count?: string;
  finalized?: string;
  missing?: boolean;
};

function fixture(values: Fixture = {}) {
  const queried: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      queried.push({ sql, params });
      if (sql.includes("from public.vendor_invoices")) {
        return { rows: values.missing ? [] : [{
          id: 7, status: values.status ?? "posted",
          grand_total: values.gross ?? "31694392.00",
          amount_paid: values.legacyPaid ?? "0",
        }] };
      }
      if (sql.includes("from public.bank_disbursement_items")) {
        return { rows: [{
          posted_amount: values.posted ?? "0",
          active_disbursements: values.count ?? "0",
        }] };
      }
      if (sql.includes("from public.payment_allocations")) {
        return { rows: [{ final_amount: values.finalized ?? "0" }] };
      }
      throw new Error("unexpected query");
    },
  } as unknown as Pick<Client, "query">;
  return { client, queried };
}

describe("server-side vendor disbursement repeat preflight (not mounted)", () => {
  it("refuses second payment for VI/00006 when BD/2026/0001 is posted despite legacy amount_paid=0", async () => {
    const { client, queried } = fixture({ posted: "31694392.00", count: "1" });
    await expect(assertVendorDisbursementMayPost(client, 1, 7, "31694392.00"))
      .rejects.toMatchObject({
        code: "VENDOR_DISBURSEMENT_PENDING_RECONCILIATION",
      });
    expect(queried).toHaveLength(2);
    expect(queried[0]!.sql).toContain("for update");
    expect(queried[0]!.params).toEqual([7, 1]);
    expect(queried[1]!.params).toEqual([7, 1]);
  });

  it("fails closed for partial posted payment as well", async () => {
    const { client } = fixture({ posted: "5000.00", count: "1" });
    await expect(assertVendorDisbursementMayPost(client, 1, 7, "3000.00"))
      .rejects.toMatchObject({
        code: "VENDOR_DISBURSEMENT_PENDING_RECONCILIATION",
      });
  });

  it("accepts first partial payment when invoice has no existing payment", async () => {
    const { client, queried } = fixture();
    const v = await assertVendorDisbursementMayPost(client, 1, 7, "5000.00");
    expect(v.remainingCents).toBe(3169439200n);
    expect(v.pendingPostedDisbursementCents).toBe(0n);
    expect(queried).toHaveLength(3);
    expect(queried.every(q => !/insert|update|delete/i.test(q.sql))).toBe(true);
  });

  it("accounts for existing FINAL bank allocations without double counting overlapping legacy paid", async () => {
    const { client } = fixture({
      gross: "100.00", legacyPaid: "40.00", finalized: "60.00",
    });
    const v = await assertVendorDisbursementMayPost(client, 1, 7, "40.00");
    expect(v.remainingCents).toBe(4000n);
    await expect(assertVendorDisbursementMayPost(client, 1, 7, "40.01"))
      .rejects.toMatchObject({ code: "VENDOR_INVOICE_OVERPAYMENT" });
  });

  it("refuses invoice without posted status or absent from scoped company", async () => {
    for (const values of [{ status: "draft" }, { missing: true }]) {
      const { client } = fixture(values);
      await expect(assertVendorDisbursementMayPost(client, 1, 7, "1.00"))
        .rejects.toMatchObject({ code: "VENDOR_INVOICE_NOT_POSTED" });
    }
  });

  it("rejects invalid or negative money before querying database", async () => {
    const { client, queried } = fixture();
    for (const amount of ["-1", "0", "NaN", "1.001"]) {
      await expect(assertVendorDisbursementMayPost(client, 1, 7, amount))
        .rejects.toBeInstanceOf(VendorDisbursementRepeatError);
    }
    expect(queried).toHaveLength(0);
  });

  it("never constructs an unscoped invoice or posted-disbursement read", async () => {
    const { client, queried } = fixture();
    await assertVendorDisbursementMayPost(client, 1, 7, "1");
    expect(queried[0]!.sql).toContain("company_id=$2");
    expect(queried[1]!.sql).toContain("bd.company_id=$2");
    expect(queried[2]!.sql).toContain("pa.company_id=$1");
  });
});
