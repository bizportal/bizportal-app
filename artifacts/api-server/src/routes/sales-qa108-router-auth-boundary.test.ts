import http from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  signed: true,
  actor: {
    id: "qa-owner-108",
    email: "owner@example.com",
    role: "super_admin",
    companyId: 1,
  },
}));
vi.mock("@workspace/db", () => ({
  pool: { query: mocks.poolQuery },
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  isSignedOtpDevEnabled: () => true,
  getDevSession: () => null,
  getProductionSession: () => mocks.signed
    ? { id: mocks.actor.id, email: mocks.actor.email, expiresAt: Date.now() + 300000 }
    : null,
  getProductionUser: async () => mocks.actor,
}));

import accountingRouter from "./accounting";
import businessDashboardRouter from "./business-dashboard";
import salesCoreRouter from "./sales-core";

describe("CST DEV signed Sales 108 passes unrelated Accounting and Dashboard routers", () => {
  let server: http.Server;
  const previousAppEnv = process.env.APP_ENV;

  beforeAll(async () => {
    process.env.APP_ENV = "development";
    const app = express();
    app.use(accountingRouter);
    app.use(businessDashboardRouter);
    app.use(salesCoreRouter);
    app.use((_req, res) => res.status(404).json({ error: "Unmatched" }));
    server = await new Promise<http.Server>(resolve => {
      const listener = app.listen(0, () => resolve(listener));
    });
  });

  afterAll(async () => {
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  beforeEach(() => {
    mocks.signed = true;
    mocks.poolQuery.mockReset();
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{
        id: 108,
        doc_number: "QA-CST-DEV-OWNER-20261120-001",
        kind: "order",
        status: "draft",
        invoice_status: "none",
        delivery_status: "to_deliver",
        payment_status: "unpaid",
        customer_id: null,
        customer_name: "QA Customer",
        total_amount: "100",
        tax_amount: "0",
        grand_total: "100",
        created_at: new Date("2026-11-20T00:00:00.000Z"),
        updated_at: new Date("2026-11-20T00:00:00.000Z"),
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 1, document_id: 108, product_id: null,
        name: "QA Item", quantity: "1", unit_price: "100", subtotal: "100",
      }] });
  });

  const request = async (path: string) => {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No test port");
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  it("returns signed Sales Order #108 200 with the canonical router order", async () => {
    const response = await request("/sales/documents/108");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: 108, kind: "order", status: "draft",
      docNumber: "QA-CST-DEV-OWNER-20261120-001",
      customerId: null,
    });
    expect(mocks.poolQuery).toHaveBeenCalledTimes(2);
  });

  it("never gives unauthenticated callers access to Sales #108", async () => {
    mocks.signed = false;
    expect((await request("/sales/documents/108")).status).toBe(401);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("does not accidentally grant another Sales ID read access", async () => {
    expect((await request("/sales/documents/107")).status).toBe(404);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("retains unauthenticated Accounting and Dashboard authentication gates", async () => {
    mocks.signed = false;
    expect((await request("/accounting/settings")).status).toBe(401);
    expect((await request("/sales/dashboard-widget")).status).toBe(401);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});
