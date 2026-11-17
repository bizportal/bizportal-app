import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  db: { transaction: m.transaction },
}));
vi.mock("../workerHeartbeat.js", () => ({
  registerHeartbeat: vi.fn(),
  beat: vi.fn(),
}));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { processCustomerPortalSalesInvoiceOutboxDevOnce, startCustomerPortalSalesInvoiceOutboxDevProcessor } from "./outboxProcessor.js";

const keys = [
  "APP_ENV", "CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV",
  "CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV",
  "CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV",
];
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const source = (overrides: Record<string, unknown> = {}) => ({
  id: 51, entry_id: 92, company_id: 1,
  payload: {
    eventType: "JOURNAL_CREATED", entryId: 92, companyId: 1,
    sourceType: "sales_invoice", sourceId: 77, amount: 100,
    actor: "qa-biz-super-admin", ref: "INV-QA-77",
    dedupeKey: "sales_invoice:1:77:92",
  },
  ...overrides,
});
const outputs = (more: unknown[][] = []) => [
  [source()], // claimed outbox
  [{ id: 92 }], // original posted journal, sales Invoice, AR + audit
  [{ id: 51 }], // exactly one outbox for source journal
  [], // zero prior financial_events
  [{ id: 1001 }], // one financial_events insert
  [{ id: 51 }], // status done
  ...more,
];
function runResponses(responses: unknown[][]) {
  let i = 0;
  m.execute.mockImplementation(async () => ({ rows: responses[i++] ?? [] }));
}
beforeEach(() => {
  vi.resetAllMocks();
  process.env.APP_ENV = "development";
  process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV = "true";
  process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV = "true";
  process.env.CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV = "true";
  m.transaction.mockImplementation(async (work) => work({ execute: m.execute }));
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("strict outbox DEV runtime scheduler", () => {
  it("does not schedule unless all explicit development flags are enabled", () => {
    process.env.CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV = "false";
    expect(startCustomerPortalSalesInvoiceOutboxDevProcessor()).toBeNull();
    expect(m.transaction).not.toHaveBeenCalled();
    process.env.APP_ENV = "production";
    process.env.CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV = "true";
    expect(startCustomerPortalSalesInvoiceOutboxDevProcessor()).toBeNull();
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("uses the existing API startup and graceful shutdown hook, not a second worker service", () => {
    const source = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
    expect(source).toContain("startCustomerPortalSalesInvoiceOutboxDevProcessor");
    expect(source).toContain("stopCustomerInvoiceOutboxDevProcessor?.()");
    expect(source).not.toContain("startOutboxProcessor()");
  });

  it("runs one strict drain on startup and stops both timers cleanly", async () => {
    vi.useFakeTimers();
    runResponses([[]]);
    const stop = startCustomerPortalSalesInvoiceOutboxDevProcessor();
    expect(stop).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    stop?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(m.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("legacy and strict outbox ownership boundary", () => {
  it("legacy poll excludes only the new exact-prefix sales-invoice events", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/accounting/outboxProcessor.ts"), "utf8",
    );
    const legacyStart = src.indexOf("async function processOutboxBatch()");
    const strictStart = src.indexOf("export async function processCustomerPortalSalesInvoiceOutboxDevOnce");
    expect(legacyStart).toBeGreaterThan(-1);
    expect(strictStart).toBeGreaterThan(legacyStart);
    const legacy = src.slice(legacyStart, strictStart);
    const strict = src.slice(strictStart);
    expect(legacy).toContain("AND NOT (");
    expect(legacy).toContain("payload->>'sourceType' = 'sales_invoice'");
    expect(legacy).toContain("left(coalesce(payload->>'dedupeKey', ''), 14) = 'sales_invoice:'");
    expect(strict).toContain("left(coalesce(payload->>'dedupeKey', ''), 14) = 'sales_invoice:'");
    expect(strict).toContain("FOR UPDATE SKIP LOCKED");
    expect(strict).toContain("CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV");
  });
});

describe("original outbox worker: strict Customer Portal invoice DEV extension", () => {
  it.each([
    ["environment", "APP_ENV", "production"],
    ["atomic posting", "CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV", "false"],
    ["AR evidence", "CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV", "false"],
    ["consumer approval", "CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV", "false"],
  ])("never starts without %s gate", async (_label, env, value) => {
    process.env[env] = value;
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toEqual({ status: "disabled" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("returns empty without a pending explicitly tagged new Invoice", async () => {
    runResponses([[]]);
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toEqual({ status: "empty" });
    expect(m.execute).toHaveBeenCalledTimes(1);
  });

  it("uses one real transaction for claim, proof, single event and done", async () => {
    runResponses(outputs());
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toEqual({ status: "processed", outboxId: 51 });
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.execute).toHaveBeenCalledTimes(6);
    const statements = m.execute.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(statements[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(statements[1]).toContain("bizportal_customer_ar_source_evidence_dev");
    expect(statements[1]).toContain("audit_accounting_events");
    expect(statements[2]).toContain("financial_outbox_events");
    expect(statements[3]).toContain("financial_events");
    expect(statements[4]).toContain("INSERT INTO public.financial_events");
    expect(statements[5]).toContain("status='done'");
  });

  it("restart after successful commit sees no pending event and never re-inserts", async () => {
    runResponses([...outputs(), []]);
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toMatchObject({ status: "processed" });
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toEqual({ status: "empty" });
    expect(m.transaction).toHaveBeenCalledTimes(2);
    expect(m.execute).toHaveBeenCalledTimes(7);
  });

  it.each([
    ["wrong company", { company_id: 2 }],
    ["wrong dedupe key", { payload: { ...source().payload, dedupeKey: "wrong-key" } }],
    ["different source ID", { payload: { ...source().payload, sourceId: 0 } }],
  ])("quarantines %s before reading or posting financial data", async (_label, partial) => {
    runResponses([[source(partial)], [{ id: 51 }]]);
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toEqual({
        status: "quarantined", outboxId: 51,
        reason: "DEV_OUTBOX_SOURCE_IDENTITY_INVALID",
      });
    expect(m.execute).toHaveBeenCalledTimes(2);
  });

  it("quarantines a missing/void/incorrect posted journal or AR proof", async () => {
    runResponses([[source()], [], [{ id: 51 }]]);
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toMatchObject({
        status: "quarantined", reason: "DEV_OUTBOX_LEDGER_AR_AUDIT_MISSING",
      });
    expect(m.execute).toHaveBeenCalledTimes(3);
  });

  it("refuses duplicate outbox rows for one journal without inserting", async () => {
    runResponses([[source()], [{ id: 92 }], [{ id: 51 }, { id: 52 }], [{ id: 51 }]]);
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toMatchObject({
        status: "quarantined", reason: "DEV_OUTBOX_DUPLICATE_JOURNAL_EVENT",
      });
    expect(m.execute).toHaveBeenCalledTimes(4);
  });

  it("never duplicates an unverified preexisting financial event", async () => {
    runResponses([[source()], [{ id: 92 }], [{ id: 51 }], [{ id: 888 }], [{ id: 51 }]]);
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .resolves.toMatchObject({
        status: "quarantined", reason: "DEV_OUTBOX_PREEXISTING_FINANCIAL_EVENT",
      });
    expect(m.execute).toHaveBeenCalledTimes(5);
  });

  it("propagates insert error to transaction rollback; cannot mark done", async () => {
    let calls = 0;
    const rows = outputs();
    m.execute.mockImplementation(async () => {
      calls++;
      if (calls === 5) throw Error("QA_FINANCIAL_EVENT_INSERT_FAILURE");
      return { rows: rows[calls - 1] };
    });
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .rejects.toThrow("QA_FINANCIAL_EVENT_INSERT_FAILURE");
    expect(m.execute).toHaveBeenCalledTimes(5);
  });

  it("rejects a missing status update receipt, so event insert cannot commit alone", async () => {
    runResponses([[source()], [{ id: 92 }], [{ id: 51 }], [], [{ id: 1001 }], []]);
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .rejects.toThrow("DEV_OUTBOX_STATUS_NOT_ATOMIC");
    expect(m.transaction).toHaveBeenCalledTimes(1);
  });

  it("never treats an unexpected claim DB error as an empty queue", async () => {
    m.execute.mockRejectedValueOnce(Error("QA_DB_UNAVAILABLE"));
    await expect(processCustomerPortalSalesInvoiceOutboxDevOnce())
      .rejects.toThrow("QA_DB_UNAVAILABLE");
  });
});
