import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  phase: "ok", reason: "", errorCode: "", env: "development",
  calls: [] as string[], logs: [] as unknown[],
}));
vi.mock("@workspace/db", () => ({
  getRuntimeDatabaseUrl: async () => {
    state.calls.push("url");
    if (state.phase === "url") throw Object.assign(new Error(state.reason), { code: state.errorCode });
    return "postgresql://SECRET:PASSWORD@db.xssrfshdrtdfupgqwfdw.supabase.co/postgres";
  },
  pool: { query: async (statement: string) => {
    state.calls.push("query");
    if (statement !== "select 1 as ok") throw Error("UNEXPECTED_SQL");
    if (state.phase === "query") throw Object.assign(new Error(state.reason), { code: state.errorCode });
    return { rows: [{ ok: 1 }], rowCount: 1 };
  }},
}));
vi.mock("../lib/smtp", () => ({
  resolveSmtpConfig: async () => ({ source: "test-smtp" }),
}));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => state.env === "development",
  initializeProductionSessionSigning: async () => {
    state.calls.push("signing");
    if (state.phase === "signing") throw Error(state.reason);
  },
}));
import health from "./health";

describe("DB-ready health: phased, secret-free dependency failures", () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.log = { warn: (...args: unknown[]) => { state.logs.push(args); } } as typeof req.log;
      next();
    });
    app.use("/api", health);
    server = createServer(app);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const a = server.address();
    if (!a || typeof a === "string") throw Error("HEALTH_HTTP_TEST_PORT_MISSING");
    base = "http://127.0.0.1:" + a.port;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => {
    Object.assign(state, { phase: "ok", reason: "", errorCode: "", env: "development" });
    state.calls.length = 0; state.logs.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());
  const ready = () => fetch(base + "/api/health/ready");
  it("keeps 200 on a genuine read-only DB ping and exposes no DSN", async () => {
    const r = await ready(); expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ status: "ok", ready: true, database: "connected",
      databaseProvider: "supabase", startupMode: "nonblocking-session-init-v2" });
    expect(JSON.stringify(body)).not.toMatch(/SECRET|PASSWORD|postgresql:\/\//i);
    expect(state.calls).toEqual(["url", "query"]);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("diagnoses GCP credential resolution before opening a DB query", async () => {
    state.phase = "url";
    state.reason = "DEV_SYSTEMD_GCP_CREDENTIAL_UNAVAILABLE; DO_NOT_LOG_SECRET token1234";
    const r = await ready(); expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toMatchObject({ status: "degraded", ready: false,
      phase: "database-configuration", reasonCode: "HEALTH_CREDENTIAL_NOT_READY" });
    expect(state.calls).toEqual(["url"]);
    expect(JSON.stringify(body) + JSON.stringify(state.logs)).not.toMatch(/DO_NOT_LOG_SECRET|token1234/i);
  });
  it("reports a PostgreSQL pool timeout separately from configuration", async () => {
    state.phase = "query"; state.reason = "Connection terminated due to connection timeout";
    const r = await ready(); expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ phase: "database-probe", reasonCode: "HEALTH_CONNECT_TIMEOUT" });
    expect(state.calls).toEqual(["url", "query"]);
  });
  it("distinguishes shared Supavisor authentication circuit breaker from this role's credentials", async () => {
    state.phase = "query";
    state.reason = "ClientHandler: circuit breaker open for operation: auth_error, too many authentication failures, new connections are temporarily blocked; secret=UNSAFE";
    const r = await ready(); expect(r.status).toBe(503);
    const raw = await r.text();
    expect(JSON.parse(raw)).toMatchObject({
      phase: "database-probe", reasonCode: "HEALTH_POOLER_AUTH_CIRCUIT_OPEN",
    });
    expect(raw + JSON.stringify(state.logs)).not.toContain("secret=UNSAFE");
  });
  it("redacts failed auth and SQLSTATE from the public response", async () => {
    state.phase = "query";
    state.reason = "password authentication failed for user POSTGRES_SECRET";
    state.errorCode = "28P01";
    const r = await ready();
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ phase: "database-probe", reasonCode: "HEALTH_DATABASE_AUTH_REJECTED" });
    expect(JSON.stringify(state.logs)).not.toContain("POSTGRES_SECRET");
  });
  it("reports pool saturation distinctly without exposing server detail", async () => {
    state.phase = "query"; state.errorCode = "53300";
    state.reason = "sorry, too many clients already on confidential endpoint";
    const response = await ready();
    expect(await response.json()).toMatchObject({ reasonCode: "HEALTH_DB_CONNECTION_LIMIT" });
    expect(JSON.stringify(state.logs)).not.toContain("confidential endpoint");
  });
  it("separates production-only signing failure from an already healthy DB", async () => {
    state.env = "production"; state.phase = "signing";
    state.reason = "session signing unavailable with secret xyz";
    const r = await ready(); expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ phase: "session-signing", reasonCode: "HEALTH_SESSION_NOT_READY" });
    expect(state.calls).toEqual(["url", "query", "signing"]);
    expect(JSON.stringify(state.logs)).not.toContain("secret xyz");
  });
  it("fails generically with unknown DB errors rather than returning raw details", async () => {
    state.phase = "query"; state.reason = "postgresql://user:secret@example.invalid/hidden";
    const response = await ready(); expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).toContain("HEALTH_DATABASE_UNAVAILABLE");
    expect(raw).not.toMatch(/postgresql|secret|example.invalid|\/hidden/i);
  });
  it("leaves liveness independent of unavailable database and sign-in", async () => {
    state.phase = "query"; state.reason = "unavailable";
    const r = await fetch(base + "/api/health/live");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok", startupMode: "nonblocking-session-init-v2" });
    expect(state.calls).toHaveLength(0);
  });
});
