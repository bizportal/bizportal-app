import { describe, expect, it } from "vitest";
import {
  commitVendorInvoicePaymentAtomic,
  type AtomicSettlementAdapter,
  type CommittedSettlement,
  type InvoiceSettlementInput,
} from "./bankDisbursementAtomicBoundary";

type State = {
  outstanding: number;
  journalCount: number;
  disbursementCount: number;
  payments: CommittedSettlement[];
};

function makeHarness(
  options: { failAt?: "journal" | "disbursement" | "balance"; missingInvoice?: boolean } = {},
) {
  let current: State = {
    outstanding: 10000, journalCount: 0, disbursementCount: 0, payments: [],
  };
  const calls: string[] = [];
  const adapter: AtomicSettlementAdapter<State> = {
    transaction: async (fn) => {
      calls.push("begin");
      const staged = structuredClone(current);
      try {
        const result = await fn(staged);
        current = staged;
        calls.push("commit");
        return result;
      } catch (error) {
        calls.push("rollback");
        throw error;
      }
    },
    lockRequestKey: async () => { calls.push("lock-key"); },
    lockInvoice: async (tx, companyId, invoiceId) => {
      calls.push("lock");
      return options.missingInvoice || companyId !== 1 || invoiceId !== 77
        ? null : { companyId: 1, invoiceId: 77, outstandingMinor: tx.outstanding, status: tx.outstanding === 0 ? "paid" as const : "posted" as const };
    },
    findByKey: async (tx, companyId, key) => {
      calls.push("find-key");
      return tx.payments.find(x => x.companyId === companyId && x.idempotencyKey === key) ?? null;
    },
    postJournal: async (tx) => {
      calls.push("journal");
      if (options.failAt === "journal") throw Error("SIMULATED_JOURNAL_FAILURE");
      tx.journalCount++;
      return tx.journalCount;
    },
    createDisbursement: async (tx, input, journalId) => {
      calls.push("disbursement");
      if (options.failAt === "disbursement") throw Error("SIMULATED_DISBURSEMENT_FAILURE");
      tx.disbursementCount++;
      tx.payments.push({
        ...input, journalId, disbursementId: tx.disbursementCount,
      });
      return tx.disbursementCount;
    },
    updateInvoiceBalance: async (tx, input) => {
      calls.push("balance");
      if (options.failAt === "balance") return false;
      if (input.grossMinor > tx.outstanding) return false;
      tx.outstanding -= input.grossMinor;
      return true;
    },
  };
  return { adapter, calls, snapshot: () => structuredClone(current) };
}

const input: InvoiceSettlementInput = {
  companyId: 1, invoiceId: 77,
  idempotencyKey: "bank-pr95-key-001", grossMinor: 6000, withholdingMinor: 600,
};

describe("Unregistered candidate bank payment atomic boundary", () => {
  it("passes the SAME transaction through posting, header and balance change", async () => {
    const h = makeHarness();
    const result = await commitVendorInvoicePaymentAtomic(input, h.adapter);
    expect(result.outcome).toBe("created");
    expect(h.snapshot()).toMatchObject({
      outstanding: 4000, journalCount: 1, disbursementCount: 1,
    });
    expect(h.calls).toEqual(["begin", "lock-key", "lock", "find-key", "journal", "disbursement", "balance", "commit"]);
  });

  it("returns exact replay without another journal and rejects mutated replay", async () => {
    const h = makeHarness();
    await commitVendorInvoicePaymentAtomic(input, h.adapter);
    expect((await commitVendorInvoicePaymentAtomic(input, h.adapter)).outcome).toBe("replayed");
    expect((await commitVendorInvoicePaymentAtomic({ ...input, grossMinor: 5999 }, h.adapter))).toEqual({
      outcome: "rejected", reason: "idempotency_conflict",
    });
    expect((await commitVendorInvoicePaymentAtomic({ ...input, withholdingMinor: 500 }, h.adapter))).toEqual({
      outcome: "rejected", reason: "idempotency_conflict",
    });
    expect(h.snapshot()).toMatchObject({ journalCount: 1, disbursementCount: 1 });
  });

  it("replays a fully settled invoice even after its status changed to paid", async () => {
    const h = makeHarness();
    const full = { ...input, grossMinor: 10000, withholdingMinor: 1000 };
    expect((await commitVendorInvoicePaymentAtomic(full, h.adapter)).outcome).toBe("created");
    expect((await commitVendorInvoicePaymentAtomic(full, h.adapter)).outcome).toBe("replayed");
    expect((await commitVendorInvoicePaymentAtomic({
      ...full, idempotencyKey: "another-full-payment-key",
    }, h.adapter))).toEqual({ outcome: "rejected", reason: "unavailable" });
    expect(h.snapshot()).toMatchObject({ outstanding: 0, journalCount: 1, disbursementCount: 1 });
  });

  it("refuses overpayment and missing company invoice before any financial write", async () => {
    const h = makeHarness();
    expect(await commitVendorInvoicePaymentAtomic({ ...input, grossMinor: 11000 }, h.adapter)).toEqual({
      outcome: "rejected", reason: "overpayment",
    });
    expect(await commitVendorInvoicePaymentAtomic({ ...input, companyId: 2 }, h.adapter)).toEqual({
      outcome: "rejected", reason: "unavailable",
    });
    expect(h.snapshot()).toMatchObject({ journalCount: 0, disbursementCount: 0 });
  });

  it.each(["journal", "disbursement", "balance"] as const)(
    "rolls back after %s failure instead of leaving a journal orphan",
    async (failAt) => {
      const h = makeHarness({ failAt });
      await expect(commitVendorInvoicePaymentAtomic(input, h.adapter)).rejects.toThrow();
      expect(h.calls.at(-1)).toBe("rollback");
      expect(h.snapshot()).toEqual({
        outstanding: 10000, journalCount: 0, disbursementCount: 0, payments: [],
      });
    },
  );

  it("fails closed on a persisted idempotency receipt missing linked journal/disbursement", async () => {
    const h = makeHarness();
    await commitVendorInvoicePaymentAtomic(input, h.adapter);
    const corrupted: AtomicSettlementAdapter<State> = {
      ...h.adapter,
      findByKey: async () => ({
        ...input, journalId: 0, disbursementId: 1,
      }),
    };
    await expect(commitVendorInvoicePaymentAtomic(input, corrupted))
      .rejects.toThrow("ATOMIC_SETTLEMENT_INCOMPLETE_RECEIPT");
    expect(h.snapshot()).toMatchObject({ journalCount: 1, disbursementCount: 1 });
  });

  it("does not commit an invalid journal ID or disbursement ID", async () => {
    for (const invalidStage of ["journal", "disbursement"] as const) {
      const h = makeHarness();
      const broken: AtomicSettlementAdapter<State> = {
        ...h.adapter,
        ...(invalidStage === "journal"
          ? { postJournal: async () => 0 }
          : { createDisbursement: async () => 0 }),
      };
      await expect(commitVendorInvoicePaymentAtomic(input, broken)).rejects.toThrow(
        invalidStage === "journal"
          ? "ATOMIC_SETTLEMENT_INVALID_JOURNAL_ID"
          : "ATOMIC_SETTLEMENT_INVALID_DISBURSEMENT_ID",
      );
      expect(h.snapshot()).toEqual({
        outstanding: 10000, journalCount: 0, disbursementCount: 0, payments: [],
      });
    }
  });

  it("rejects invalid authoritative outstanding balances before financial writes", async () => {
    const h = makeHarness();
    const broken: AtomicSettlementAdapter<State> = {
      ...h.adapter,
      lockInvoice: async () => ({
        companyId: 1, invoiceId: 77, status: "posted",
        outstandingMinor: Number.NaN,
      }),
    };
    await expect(commitVendorInvoicePaymentAtomic(input, broken))
      .rejects.toThrow("ATOMIC_SETTLEMENT_INVALID_AUTHORITY_BALANCE");
    expect(h.snapshot()).toMatchObject({ journalCount: 0, disbursementCount: 0 });
  });

  it("validates request identity and WHT before starting a DB transaction", async () => {
    const h = makeHarness();
    expect(await commitVendorInvoicePaymentAtomic({
      ...input, idempotencyKey: "bad", withholdingMinor: 6000,
    }, h.adapter)).toEqual({ outcome: "rejected", reason: "invalid" });
    expect(h.calls).toHaveLength(0);
  });
});
