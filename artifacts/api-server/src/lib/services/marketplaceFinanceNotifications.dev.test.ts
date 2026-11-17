import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ execute: vi.fn(), activity: vi.fn() }));
vi.mock("@workspace/db", () => ({ db: { execute: mock.execute } }));
vi.mock("../logger.js", () => ({ logger: {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} }));
vi.mock("../activityLog.js", () => ({ logActivity: mock.activity }));

import { enqueueNotification, resetNotifQueueTableReadiness } from "./marketplaceNotificationQueueService.js";

const invoiceEvents = [
  "mkt_vendor_invoice_uploaded", "mkt_vendor_invoice_ready_for_ap",
  "mkt_vendor_invoice_submitted", "mkt_ap_preparation_created",
  "mkt_ap_finance_reviewed", "mkt_ap_waiting_payment",
];
const savedApp = process.env.APP_ENV;
const savedFlag = process.env.BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV;
const request = (eventType = invoiceEvents[0], recipientType = "admin") => ({
  eventType, recipientType, purchaseOrderId: 14, payloadJson: { test: true },
});

beforeEach(() => {
  vi.resetAllMocks();
  resetNotifQueueTableReadiness();
  process.env.APP_ENV = "development";
  process.env.BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV = "true";
  mock.execute.mockResolvedValueOnce({ rows: [{ exists: true }] })
    .mockResolvedValue({ rows: [{ id: 42 }] });
  mock.activity.mockResolvedValue(undefined);
});
afterEach(async () => {
  await vi.dynamicImportSettled();
  if (savedApp === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = savedApp;
  if (savedFlag === undefined) delete process.env.BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV;
  else process.env.BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV = savedFlag;
});

describe("explicit DEV Finance test notifications", () => {
  it.each(invoiceEvents)("never inserts %s into the shared outbound queue", async (eventType) => {
    expect(await enqueueNotification(request(eventType))).toBe(0);
    expect(mock.execute).not.toHaveBeenCalled();
    expect(mock.activity).not.toHaveBeenCalled();
  });

  it.each([undefined, "false", "TRUE"])("retains default delivery when the flag is %s", async (flag) => {
    if (flag === undefined) delete process.env.BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV;
    else process.env.BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV = flag;
    expect(await enqueueNotification(request())).toBe(42);
    expect(mock.execute).toHaveBeenCalledTimes(2);
  });

  it.each(["production", undefined])("cannot suppress notifications outside explicit DEV (%s)", async (app) => {
    if (app === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = app;
    expect(await enqueueNotification(request())).toBe(42);
    expect(mock.execute).toHaveBeenCalledTimes(2);
  });

  it("preserves existing vendor invitation events in DEV", async () => {
    expect(await enqueueNotification(request("mkt_vendor_invitation_notification", "vendor"))).toBe(42);
    expect(mock.execute).toHaveBeenCalledTimes(2);
  });

  it("only suppresses the existing admin Finance notification recipients", async () => {
    expect(await enqueueNotification(request(invoiceEvents[0], "vendor"))).toBe(42);
    expect(mock.execute).toHaveBeenCalledTimes(2);
  });
});
