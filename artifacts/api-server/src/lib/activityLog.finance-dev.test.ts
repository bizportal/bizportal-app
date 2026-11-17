import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ global: vi.fn(), scoped: vi.fn(), transaction: vi.fn(), warn: vi.fn() }));
vi.mock("@workspace/db", () => ({ db: { execute: probe.global }, withMarketplaceFinanceDevTransaction: probe.transaction }));
vi.mock("./logger.js", () => ({ logger: { warn: probe.warn } }));
import { logActivity } from "./activityLog";
const original = { app: process.env.APP_ENV, company: process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV };
const event = { marketplaceFinanceCompanyId: 1, mktPurchaseOrderId: 11, action: "invoice_uploaded",
  actorType: "vendor", actorId: "10", newValue: { invoiceId: 14, goodsReceiptId: 13, status: "draft" } };
beforeEach(() => {
  vi.resetAllMocks(); process.env.APP_ENV = "development";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV = "true";
  probe.transaction.mockImplementation(async (_id, work) => work({ execute: probe.scoped }));
});
afterEach(() => {
  for (const [key,value] of [["APP_ENV",original.app], ["BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV",original.company]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});
describe("Finance activity uses the verified company session", () => {
  it("awaits the real scoped insert and never uses the shared OTP/admin pool", async () => {
    let complete!: () => void;
    probe.scoped.mockReturnValue(new Promise<void>(resolve => { complete = resolve; }));
    let settled = false;
    const pending = logActivity(event).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    expect(probe.transaction).toHaveBeenCalledWith(1, expect.any(Function));
    expect(probe.global).not.toHaveBeenCalled();
    complete(); await pending; expect(settled).toBe(true);
  });
  it("does not fall back to the shared pool after a company privilege or identity failure", async () => {
    probe.transaction.mockRejectedValue(new Error("DEV_FINANCE_ROLE_OR_RLS_UNVERIFIED"));
    await logActivity(event);
    expect(probe.global).not.toHaveBeenCalled(); expect(probe.warn).toHaveBeenCalledOnce();
  });
  it("rejects an unrelated action tagged as Finance without falling back", async () => {
    await logActivity({ ...event, action: "user_promoted" });
    expect(probe.transaction).not.toHaveBeenCalled(); expect(probe.global).not.toHaveBeenCalled();
    expect(probe.warn).toHaveBeenCalledOnce();
  });
  it("retains the existing global audit path for unrelated callers", async () => {
    await logActivity({ action: "order_created", orderId: 7 });
    expect(probe.global).toHaveBeenCalledOnce(); expect(probe.transaction).not.toHaveBeenCalled();
  });
  it("retains the existing production path even if a caller supplies company metadata", async () => {
    process.env.APP_ENV = "production"; await logActivity(event);
    expect(probe.global).toHaveBeenCalledOnce(); expect(probe.transaction).not.toHaveBeenCalled();
  });
});
