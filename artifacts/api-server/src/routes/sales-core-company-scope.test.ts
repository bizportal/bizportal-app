import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

type TestActor = { id: string; email: string; role: string; companyId: number | null };
const state = vi.hoisted(() => ({
  actor: null as TestActor | null,
  queries: [] as Array<{ sql: string; values: unknown[] }>,
}));

vi.mock("./admin-auth", () => ({
  authenticateAdmin: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!state.actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    (req as express.Request & { adminUser?: TestActor }).adminUser = state.actor;
    next();
  },
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: async (sql: string, values: unknown[]) => {
      state.queries.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  },
}));

import salesCoreRouter from "./sales-core";

describe("Sales AI draft API preserves active company isolation", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    const app = express();
    app.use("/api", salesCoreRouter);
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("NO_LISTENER");
    url = "http://127.0.0.1:" + address.port + "/api/sales/ai-drafts";
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  });
  beforeEach(() => {
    state.actor = null;
    state.queries.length = 0;
  });
  const actor = (role: string, companyId: number | null): TestActor => ({
    id: "test-user", email: "test@example.invalid", role, companyId,
  });

  it("denies missing authentication without hitting the DB", async () => {
    const response = await fetch(url);
    expect(response.status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });

  it("denies non-global Admin, Finance, and Accounting without an assigned company", async () => {
    for (const role of ["admin", "finance", "accounting"]) {
      state.actor = actor(role, null);
      const response = await fetch(url);
      expect(response.status).toBe(403);
      const body = await response.json() as { code?: string };
      expect(body.code).toBe("COMPANY_SCOPE_REQUIRED");
    }
    expect(state.queries).toHaveLength(0);
  });

  it("denies invalid company identities instead of treating them as all-company", async () => {
    for (const companyId of [0, -1, Number.NaN]) {
      state.actor = actor("finance", companyId);
      const response = await fetch(url);
      expect(response.status).toBe(403);
    }
    expect(state.queries).toHaveLength(0);
  });

  it("uses the stored actor company, never an untrusted query override", async () => {
    state.actor = actor("finance", 1);
    const response = await fetch(url + "?company_id=2");
    expect(response.status).toBe(200);
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]?.values).toEqual([1]);
    expect(state.queries[0]?.sql).toContain("company_id = $1");
  });

  it("preserves intentional cross-company read for global Super Admin and Owner", async () => {
    for (const role of ["super_admin", "owner"]) {
      state.actor = actor(role, null);
      const response = await fetch(url);
      expect(response.status).toBe(200);
    }
    expect(state.queries).toHaveLength(2);
    expect(state.queries.every((query) => query.values.length === 1 && query.values[0] === null)).toBe(true);
  });
});
