import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const { access, queries } = vi.hoisted(() => ({
  access: { actor: null as null | { id: string; email: string; role: string; companyId: number | null }, dev: true },
  queries: vi.fn(async () => ({ rows: [] })),
}));

vi.mock("@workspace/db", () => ({ pool: { query: queries } }));
vi.mock("./dev-auth", () => ({ isDevelopmentEnvironment: () => access.dev }));
vi.mock("./admin-auth", () => ({
  authenticateAdmin: (req: any, res: any, next: () => void) => {
    if (!access.actor) return res.status(401).json({ error: "Unauthorized" });
    req.adminUser = access.actor;
    next();
  },
}));

import router from "./customer-ar-match-preview";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = { error: () => {} };
    next();
  });
  app.use("/api", router);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}/api/sales/customer-invoices/auto-match-preview`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  access.dev = true;
  access.actor = null;
  queries.mockClear();
});

async function check(companyId: number) {
  const response = await fetch(`${base}?company_id=${companyId}`);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe("DEV Customer AR HTTP tenant isolation", () => {
  it("denies finance without a verified company binding even in DEV", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "finance", companyId: null };
    const result = await check(2);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("COMPANY_SCOPE_MISSING");
    expect(queries).not.toHaveBeenCalled();
  });

  it("denies an ordinary admin trying another company without reading rows", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "admin", companyId: 1 };
    const result = await check(2);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("COMPANY_SCOPE_MISMATCH");
    expect(queries).not.toHaveBeenCalled();
  });

  it("allows a company-scoped finance reader but creates no settlement", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "finance", companyId: 1 };
    const result = await check(1);
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe("read_only_preview");
    expect(result.body.autoApproveEnabled).toBe(false);
    expect(result.body.autoPostEnabled).toBe(false);
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("allows explicitly privileged owner to select a company", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "owner", companyId: null };
    const result = await check(2);
    expect(result.status).toBe(200);
    expect(result.body.companyId).toBe(2);
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("rejects anonymous callers and keeps PROD route inaccessible", async () => {
    expect((await check(1)).status).toBe(401);
    access.actor = { id: "a", email: "test@invalid.example", role: "owner", companyId: null };
    access.dev = false;
    expect((await check(1)).status).toBe(404);
    expect(queries).not.toHaveBeenCalled();
  });
});
