/** Parent HTTP contract; receipt SQL is real, child output is a controlled fixture. */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import pg from "pg";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const fake = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), scope: vi.fn(), dev: vi.fn(), global: vi.fn(), company: vi.fn(),
  spawn: vi.fn(), workerBytes: "fixed QA worker fixture", symbolicLink: false,
  child: null as any, stdin: null as any, proof: null as any, hold: false,
  exitCode: 0, stderr: "", wrongRunId: false, ignoreTerm: false, onStarted: null as null | (() => void),
}));
vi.mock("./dev-auth", () => ({
  getProductionSession: fake.session, getProductionUser: fake.user,
  getFinanceCompanyScope: fake.scope, isApprovedFinanceGlobalSuperAdmin: fake.global,
  isApprovedFinanceGlobalCompany: fake.company, isDevelopmentEnvironment: fake.dev,
}));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    lstat: async (filename: string) => filename.endsWith("scripts/qa/dist/po14-real-worker.mjs")
      ? { isFile: () => true, isSymbolicLink: () => fake.symbolicLink, size: fake.workerBytes.length }
      : actual.lstat(filename),
    readFile: async (filename: string, ...args: any[]) => filename.endsWith("scripts/qa/dist/po14-real-worker.mjs")
      ? Buffer.from(fake.workerBytes) : (actual.readFile as any)(filename, ...args),
  };
});
vi.mock("pg", async original => {
  const actual = await original<typeof import("pg")>();
  return { ...actual, default: { ...actual.default,
    // Exact production gate stays 55495. Tests write ONLY their fresh disposable 55497 DB.
    Client: class extends actual.default.Client {
      constructor(config: any) {
        if (config?.connectionString !== "postgres://postgres@127.0.0.1:55495/finance_approval_qa") {
          throw new Error("UNEXPECTED_QA_PARENT_DATABASE");
        }
        super({ ...config, connectionString: "postgres://postgres@127.0.0.1:55497/finance_approval_qa" });
      }
    },
  } };
});
import route from "./dev-finance-po14-e2e-qa";

let server: Server, base: string, db: pg.Client;
let databaseCreated = false;
const endpoint = "/api/mkt/admin/po14-e2e-qa";
const reference = "PO-20261117-00014";
function proof() {
  return {
    ok: true, contract: "po14-real-sql-v1", reference,
    actor: { email: "owner@qa.invalid", companyId: 1 },
    entities: { invoiceId: 1, apId: 1, requestId: 1, handoffId: 1, mutationId: 2,
      matchId: 3, groupId: 4, allocationId: 5, journalId: 6 },
    totals: { debit: "100000.00", credit: "100000.00" },
    checks: { invoiceCreated: true, threeWayMatched: true, apPrepared: true,
      paymentApproved: true, bankImported: true, automaticMatched: true,
      allocationCreated: true, journalPosted: true, paymentFinalized: true,
      replayIdempotent: true, auditRollback: true },
    auditCounts: { approval: 1, bank: 1, finalization: 1 },
    isolatedDatabase: { name: "po14_bank_ingestion_qa_0123456789abcdef", removed: true },
    outboundNotifications: 0, sheetTransport: "synthetic_fixture",
    businessDatabaseUsed: false, realBankTransfer: false,
  };
}
function completeChild() {
  if (fake.stderr) fake.child.stderr.emit("data", Buffer.from(fake.stderr));
  fake.child.stdout.emit("data", Buffer.from(JSON.stringify(fake.proof)));
  fake.child.emit("close", fake.exitCode);
}
function post(origin?: string, body: unknown = { reference }) {
  return fetch(base + endpoint, { method: "POST", headers: { "Content-Type": "application/json",
    Origin: origin ?? "https://" + new URL(base).host, "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify(body) });
}
async function counts() {
  return (await db.query(`select
    (select count(*)::int from public.qa_po14_real_e2e_runs) runs,
    (select count(*)::int from public.qa_po14_real_e2e_audit) audits`)).rows[0];
}
beforeAll(async () => {
  const actual = await vi.importActual<typeof import("pg")>("pg");
  const bootstrap = new actual.default.Client({ connectionString: "postgres://postgres@127.0.0.1:55497/postgres" });
  await bootstrap.connect();
  try {
    const found = await bootstrap.query("select 1 from pg_database where datname='finance_approval_qa'");
    if (found.rowCount) throw new Error("QA_RECEIPT_TEST_REQUIRES_FRESH_DISPOSABLE_POSTGRES");
    await bootstrap.query("create database finance_approval_qa");
    databaseCreated = true;
  } finally { await bootstrap.end(); }
  db = new actual.default.Client({ connectionString: "postgres://postgres@127.0.0.1:55497/finance_approval_qa" });
  await db.connect();
  await db.query(readFileSync(path.resolve(import.meta.dirname,
    "../../../../scripts/sql/20261125_po14_real_browser_receipt_localhost_ONLY.sql"), "utf8"));
  await db.query("create table public.qa_po14_e2e_runs(id serial primary key,status text)");
  const app = express(); app.use(express.json()); app.use("/api", route);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}, 30_000);
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await db?.end();
  if (databaseCreated) {
    const actual = await vi.importActual<typeof import("pg")>("pg");
    const bootstrap = new actual.default.Client({ connectionString: "postgres://postgres@127.0.0.1:55497/postgres" });
    await bootstrap.connect();
    try { await bootstrap.query("drop database finance_approval_qa"); } finally { await bootstrap.end(); }
  }
});
beforeEach(async () => {
  fake.dev.mockReturnValue(true); fake.session.mockReturnValue({ id: "signed" });
  fake.user.mockResolvedValue({ email: "owner@qa.invalid", role: "super_admin", companyId: 1 });
  fake.global.mockReturnValue(false); fake.company.mockReturnValue(true); fake.scope.mockReturnValue(null);
  fake.hold = false; fake.exitCode = 0; fake.stderr = ""; fake.onStarted = null;
  fake.wrongRunId = false; fake.ignoreTerm = false;
  fake.symbolicLink = false; fake.workerBytes = "fixed QA worker fixture"; fake.proof = proof();
  fake.spawn.mockReset();
  fake.spawn.mockImplementation(() => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = vi.fn((signal: string) => {
      if (signal !== "SIGTERM" || !fake.ignoreTerm) queueMicrotask(() => child.emit("close", 143));
      return true;
    });
    child.stdin.end = vi.fn((value: string) => {
      fake.stdin = JSON.parse(value);
      fake.proof.runId = fake.wrongRunId ? "00000000-0000-4000-8000-000000000000" : fake.stdin.runId;
      fake.onStarted?.();
      if (!fake.hold) queueMicrotask(completeChild);
    });
    fake.child = child; return child;
  });
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV", "true");
  vi.stubEnv("BIZPORTAL_FINANCE_PO14_REAL_QA_ENABLED_DEV", "true");
  vi.stubEnv("BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL", "postgres://postgres@127.0.0.1:55495/finance_approval_qa");
  await db.query("truncate public.qa_po14_real_e2e_audit,public.qa_po14_real_e2e_runs,public.qa_po14_e2e_runs restart identity cascade");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("signed PO14 parent HTTP and actual isolated receipt SQL", () => {
  it("stores only verified worker evidence and reuses one immutable receipt on replay", async () => {
    const first = await post(); expect(first.status).toBe(200);
    const data = await first.json() as any;
    expect(data).toMatchObject({ contractVersion: 2, sandbox: true, replay: false,
      result: { actor: "owner@qa.invalid", auditCount: 1, evidence: proof() } });
    expect(data.result.workerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await (await post()).json() as any).replay).toBe(true);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({ runs: 1, audits: 1 });
  });
  it("does not inherit business secrets or accept a caller-selected actor or executable", async () => {
    vi.stubEnv("DATABASE_URL", "must-not-be-inherited"); vi.stubEnv("SESSION_SECRET", "must-not-be-inherited");
    expect((await post(undefined, { reference, actor: "forged" })).status).toBe(422);
    expect((await post()).status).toBe(200);
    const [binary, args, options] = fake.spawn.mock.calls[0];
    expect(binary).toBe(process.execPath);
    expect(args).toEqual([path.resolve(process.cwd(), "scripts/qa/dist/po14-real-worker.mjs")]);
    expect(options).toMatchObject({ shell: false, env: { APP_ENV: "development", NODE_ENV: "production",
      TZ: "Asia/Jakarta", BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV: "true" } });
    expect(Object.keys(options.env).sort()).toEqual(["APP_ENV", "BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV", "NODE_ENV", "TZ"]);
    expect(fake.stdin).toMatchObject({ version: 1, reference,
      actor: { source: "signed_server_session", role: "super_admin", email: "owner@qa.invalid", companyId: 1 } });
    expect(fake.stdin.runId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("ignores all old SIMULATED rows and binds receipts to the actual worker hash", async () => {
    await db.query("insert into public.qa_po14_e2e_runs(status) values('SIMULATED')");
    expect((await (await fetch(base + endpoint)).json() as any).result).toBeNull();
    expect((await post()).status).toBe(200);
    fake.workerBytes = "next worker candidate";
    expect((await (await fetch(base + endpoint)).json() as any).result).toBeNull();
    expect((await post()).status).toBe(200);
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(await counts()).toEqual({ runs: 2, audits: 2 });
  });
  it("serializes real work across concurrent HTTP requests", async () => {
    fake.hold = true;
    const started = new Promise<void>(resolve => { fake.onStarted = resolve; });
    const first = post(); await started;
    const second = await post();
    expect(second.status).toBe(409); expect((await second.json() as any).code).toBe("QA_RUNNING");
    completeChild(); expect((await first).status).toBe(200);
    expect(fake.spawn).toHaveBeenCalledTimes(1); expect(await counts()).toEqual({ runs: 1, audits: 1 });
  });
  it.each(["unmatched", "unbalanced", "uncleaned", "different_actor", "different_run", "duplicate_audit", "simulation"])(
    "refuses incomplete or contradictory worker evidence: %s", async reason => {
      if (reason === "unmatched") fake.proof.checks.automaticMatched = false;
      if (reason === "unbalanced") fake.proof.totals.credit = "99999.00";
      if (reason === "uncleaned") fake.proof.isolatedDatabase.removed = false;
      if (reason === "different_actor") fake.proof.actor.email = "other@qa.invalid";
      if (reason === "different_run") fake.wrongRunId = true;
      if (reason === "duplicate_audit") fake.proof.auditCounts.bank = 2;
      if (reason === "simulation") fake.proof = { status: "completed", steps: [{ status: "SIMULATED" }] };
      const result = await post(); expect(result.status).toBe(503);
      expect((await result.json() as any).code).toBe("QA_EVIDENCE_INVALID");
      expect(await counts()).toEqual({ runs: 0, audits: 0 });
    },
  );
  it("returns a bounded failure code without exposing child stderr", async () => {
    fake.exitCode = 1; fake.stderr = "DO_NOT_EXPOSE_DATABASE_SECRET";
    const result = await post(); expect(result.status).toBe(503);
    const body = await result.text(); expect(body).toContain("QA_WORKER_FAILED");
    expect(body).not.toContain(fake.stderr); expect(await counts()).toEqual({ runs: 0, audits: 0 });
  });
  it("rolls back a receipt if its audit INSERT fails", async () => {
    await db.query(`create function qa_fail_receipt_audit() returns trigger language plpgsql as $$
      begin raise exception 'injected receipt audit fault'; end $$;
      create trigger qa_fail_receipt_audit before insert on public.qa_po14_real_e2e_audit
      for each row execute function qa_fail_receipt_audit()`);
    try { expect((await post()).status).toBe(503); expect(await counts()).toEqual({ runs: 0, audits: 0 }); }
    finally { await db.query("drop trigger qa_fail_receipt_audit on public.qa_po14_real_e2e_audit; drop function qa_fail_receipt_audit()"); }
  });
  it("stops a timed-out worker and records no successful receipt", async () => {
    fake.hold = true;
    const started = new Promise<void>(resolve => { fake.onStarted = resolve; });
    const timeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, delay?: number, ...args: any[]) =>
      timeout(fn, delay === 120_000 ? 30 : delay, ...args)) as typeof setTimeout);
    try {
      const request = post(); await started;
      const result = await request; expect(result.status).toBe(503);
      expect((await result.json() as any).code).toBe("QA_WORKER_TIMEOUT");
      expect(fake.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(timerSpy.mock.calls.some(call => call[1] === 25_000)).toBe(true);
      expect(await counts()).toEqual({ runs: 0, audits: 0 });
    } finally { timerSpy.mockRestore(); }
  });
  it("allows the 25-second cleanup grace before force-stopping an unresponsive child", async () => {
    fake.hold = true; fake.ignoreTerm = true;
    const timeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, delay?: number, ...args: any[]) =>
      timeout(fn, delay === 120_000 ? 10 : delay === 25_000 ? 30 : delay, ...args)) as typeof setTimeout);
    try {
      const result = await post(); expect(result.status).toBe(503);
      expect(fake.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(timerSpy.mock.calls.some(call => call[1] === 25_000)).toBe(true);
      expect(await counts()).toEqual({ runs: 0, audits: 0 });
    } finally { timerSpy.mockRestore(); }
  });
  it("retains signed Super Admin company and same-origin checks", async () => {
    fake.session.mockReturnValue(null); expect((await post()).status).toBe(401);
    fake.session.mockReturnValue({ id: "signed" });
    fake.user.mockResolvedValue({ email: "owner@qa.invalid", role: "admin", companyId: 1 });
    expect((await post()).status).toBe(403);
    fake.user.mockResolvedValue({ email: "owner@qa.invalid", role: "super_admin", companyId: 3 });
    expect((await post()).status).toBe(403);
    fake.user.mockResolvedValue({ email: "owner@qa.invalid", role: "super_admin", companyId: 1 });
    expect((await post("https://foreign.invalid")).status).toBe(403);
    expect(fake.spawn).not.toHaveBeenCalled(); expect(await counts()).toEqual({ runs: 0, audits: 0 });
  });
  it("refuses production, either disabled flag, nonlocal QA DSN and symlinked worker", async () => {
    vi.stubEnv("APP_ENV", "production"); expect((await post()).status).toBe(404);
    vi.stubEnv("APP_ENV", "development"); vi.stubEnv("BIZPORTAL_FINANCE_PO14_REAL_QA_ENABLED_DEV", "false");
    expect((await post()).status).toBe(404);
    vi.stubEnv("BIZPORTAL_FINANCE_PO14_REAL_QA_ENABLED_DEV", "true");
    vi.stubEnv("BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV", "false"); expect((await post()).status).toBe(404);
    vi.stubEnv("BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV", "true");
    vi.stubEnv("BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL", "postgres://postgres@business.invalid/db");
    expect((await post()).status).toBe(404);
    vi.stubEnv("BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL", "postgres://postgres@127.0.0.1:55495/finance_approval_qa");
    fake.symbolicLink = true; expect((await post()).status).toBe(503);
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});
