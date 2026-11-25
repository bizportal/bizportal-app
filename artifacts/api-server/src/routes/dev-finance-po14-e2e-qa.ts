/** Signed Owner entry to existing services in a disposable, localhost-only DB. */
import { Router } from "express";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  getProductionSession, getProductionUser, getFinanceCompanyScope,
  isApprovedFinanceGlobalSuperAdmin, isApprovedFinanceGlobalCompany,
  isDevelopmentEnvironment,
} from "./dev-auth";

const router = Router();
const endpoint = "/mkt/admin/po14-e2e-qa";
const reference = "PO-20261117-00014";
const expected = "postgres://postgres@127.0.0.1:55495/finance_approval_qa";
const workerRelativePath = "scripts/qa/dist/po14-real-worker.mjs";
const workerContract = "po14-real-sql-v1";
const timeoutMs = 120_000;
const outputLimit = 128 * 1024;
const entityKeys = ["invoiceId", "apId", "requestId", "handoffId", "mutationId",
  "matchId", "groupId", "allocationId", "journalId"] as const;
const checkKeys = ["invoiceCreated", "threeWayMatched", "apPrepared", "paymentApproved",
  "bankImported", "automaticMatched", "allocationCreated", "journalPosted",
  "paymentFinalized", "replayIdempotent", "auditRollback"] as const;

type SignedActor = {
  source: "signed_server_session"; role: "super_admin"; email: string; companyId: 1;
};
type Proof = {
  ok: true; contract: typeof workerContract; reference: typeof reference; runId: string;
  actor: { email: string; companyId: 1 };
  entities: Record<typeof entityKeys[number], number>;
  totals: { debit: "100000.00"; credit: "100000.00" };
  checks: Record<typeof checkKeys[number], true>;
  auditCounts: { approval: 1; bank: 1; finalization: 1 };
  isolatedDatabase: { name: string; removed: true };
  outboundNotifications: 0; sheetTransport: "synthetic_fixture";
  businessDatabaseUsed: false; realBankTransfer: false;
};

function gate() {
  return isDevelopmentEnvironment() && process.env.APP_ENV === "development" &&
    process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV === "true" &&
    process.env.BIZPORTAL_FINANCE_PO14_REAL_QA_ENABLED_DEV === "true" &&
    process.env.BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL === expected;
}

async function actor(req: any, res: any): Promise<SignedActor | null> {
  if (!gate()) { res.status(404).json({ error: "Not found" }); return null; }
  const session = getProductionSession(req);
  if (!session) { res.status(401).json({ error: "Sesi Super Admin diperlukan" }); return null; }
  try {
    const user = await getProductionUser(session);
    if (!user || user.role.toLowerCase() !== "super_admin") {
      res.status(403).json({ error: "Hanya Super Admin" }); return null;
    }
    const company = user.companyId === null && isApprovedFinanceGlobalSuperAdmin(user.email)
      ? getFinanceCompanyScope(req, session) : user.companyId;
    if (company !== 1 || (user.companyId === null && !isApprovedFinanceGlobalCompany(1))) {
      res.status(403).json({ error: "Pilih dan verifikasi Finance CST" }); return null;
    }
    return { source: "signed_server_session", role: "super_admin", email: user.email, companyId: 1 };
  } catch { res.status(503).json({ error: "Gagal memverifikasi sesi" }); return null; }
}

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: expected, connectionTimeoutMillis: 3000 });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function workerIdentity() {
  // Deployment controls this exact location. No request or environment value is a path.
  const filename = path.resolve(process.cwd(), workerRelativePath);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 40 * 1024 * 1024) {
    throw new Error("QA_WORKER_NOT_READY");
  }
  return { filename, sha256: createHash("sha256").update(await readFile(filename)).digest("hex") };
}

function validateProof(value: unknown, verified: SignedActor, runId: string): Proof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QA_EVIDENCE_INVALID");
  const p = value as any;
  if (p.ok !== true || p.contract !== workerContract || p.reference !== reference || p.runId !== runId ||
      p.actor?.email !== verified.email || p.actor?.companyId !== 1 ||
      !entityKeys.every(key => Number.isSafeInteger(p.entities?.[key]) && p.entities[key] > 0) ||
      !checkKeys.every(key => p.checks?.[key] === true) ||
      p.totals?.debit !== "100000.00" || p.totals?.credit !== "100000.00" ||
      p.auditCounts?.approval !== 1 || p.auditCounts?.bank !== 1 || p.auditCounts?.finalization !== 1 ||
      typeof p.isolatedDatabase?.name !== "string" ||
      !/^po14_bank_ingestion_qa_[a-f0-9]{12,64}$/.test(p.isolatedDatabase.name) ||
      p.isolatedDatabase.removed !== true || p.outboundNotifications !== 0 ||
      p.sheetTransport !== "synthetic_fixture" || p.businessDatabaseUsed !== false ||
      p.realBankTransfer !== false) throw new Error("QA_EVIDENCE_INVALID");
  // Copy only documented fields; never relay arbitrary child output to the browser.
  return {
    ok: true, contract: workerContract, reference, runId, actor: { email: verified.email, companyId: 1 },
    entities: Object.fromEntries(entityKeys.map(key => [key, p.entities[key]])) as Proof["entities"],
    totals: { debit: "100000.00", credit: "100000.00" },
    checks: Object.fromEntries(checkKeys.map(key => [key, true])) as Proof["checks"],
    auditCounts: { approval: 1, bank: 1, finalization: 1 },
    isolatedDatabase: { name: p.isolatedDatabase.name, removed: true },
    outboundNotifications: 0, sheetTransport: "synthetic_fixture",
    businessDatabaseUsed: false, realBankTransfer: false,
  };
}

function executeWorker(filename: string, verified: SignedActor, runId: string): Promise<Proof> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename], {
      cwd: process.cwd(), shell: false, stdio: ["pipe", "pipe", "pipe"],
      // No inherited credentials, session secret, NODE_OPTIONS or PATH.
      env: { APP_ENV: "development", NODE_ENV: "production", TZ: "Asia/Jakarta",
        BIZPORTAL_FINANCE_NOTIFICATIONS_SUPPRESSED_DEV: "true" },
    });
    let output = "";
    let bytes = 0;
    let failure: string | null = null;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      child.kill("SIGTERM");
      // The worker allows 10s SQL timeouts and then drops its own disposable DB.
      forceKill = setTimeout(() => { child.kill("SIGKILL"); }, 25_000);
      forceKill.unref();
    };
    const timer = setTimeout(() => stop("QA_WORKER_TIMEOUT"), timeoutMs);
    timer.unref();
    const finish = (error?: Error, proof?: Proof) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (forceKill) clearTimeout(forceKill);
      if (error) reject(error); else resolve(proof!);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputLimit) { stop("QA_WORKER_OUTPUT_LIMIT"); return; }
      output += chunk.toString("utf8");
    });
    // Drain stderr without returning secrets, query parameters, or stack traces.
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > outputLimit) stop("QA_WORKER_OUTPUT_LIMIT");
    });
    child.on("error", () => finish(new Error("QA_WORKER_UNAVAILABLE")));
    child.stdin.on("error", () => stop("QA_WORKER_INPUT_FAILED"));
    child.on("close", code => {
      if (failure || code !== 0) { finish(new Error(failure ?? "QA_WORKER_FAILED")); return; }
      try { finish(undefined, validateProof(JSON.parse(output), verified, runId)); }
      catch { finish(new Error("QA_EVIDENCE_INVALID")); }
    });
    child.stdin.end(JSON.stringify({ version: 1, reference, runId, actor: verified }) + "\n");
  });
}

async function readReceipt(client: pg.Client, sha256: string, verified: SignedActor) {
  const row = (await client.query(
    `select r.id,r.reference,r.company_id,r.actor,r.amount::text,r.evidence,r.worker_sha256,r.created_at,
      (select count(*)::integer from public.qa_po14_real_e2e_audit a where a.run_id=r.id) audit_count
     from public.qa_po14_real_e2e_runs r
     where r.reference=$1 and r.company_id=1 and r.contract_version=2 and r.worker_sha256=$2 limit 1`,
    [reference, sha256],
  )).rows[0];
  if (!row) return null;
  if (row.actor !== verified.email) throw new Error("QA_DIFFERENT_ACTOR");
  if (row.audit_count !== 1 || row.amount !== "100000.00") throw new Error("QA_RECEIPT_INVALID");
  return {
    id: row.id, reference, companyId: 1, actor: row.actor, amount: row.amount,
    createdAt: row.created_at, auditCount: row.audit_count, workerSha256: row.worker_sha256,
    evidence: validateProof(row.evidence, verified, row.id),
  };
}

function response(result: Awaited<ReturnType<typeof readReceipt>>, replay = false) {
  return { contractVersion: 2, sandbox: true, bankTransfer: false, businessLedgerPosted: false,
    sheetTransport: "synthetic_fixture", result, replay };
}

function reportFailure(res: any, error: unknown) {
  const code = error instanceof Error ? error.message : "QA_UNAVAILABLE";
  if (code === "QA_DIFFERENT_ACTOR") {
    res.status(409).json({ error: "Bukti QA ini dimiliki sesi Super Admin lain", code }); return;
  }
  const known = new Set(["QA_WORKER_TIMEOUT", "QA_WORKER_FAILED", "QA_WORKER_UNAVAILABLE", "QA_WORKER_CHANGED", "QA_WORKER_NOT_READY",
    "QA_WORKER_INPUT_FAILED", "QA_WORKER_OUTPUT_LIMIT", "QA_EVIDENCE_INVALID", "QA_RECEIPT_INVALID"]);
  res.status(503).json({ error: "Pengujian SQL belum berhasil diverifikasi. Tidak ada hasil PASS baru.",
    code: known.has(code) ? code : "QA_UNAVAILABLE" });
}

router.get(endpoint, async (req, res) => {
  const verified = await actor(req, res); if (!verified) return;
  try {
    const worker = await workerIdentity();
    const result = await withDb(client => readReceipt(client, worker.sha256, verified));
    res.setHeader("Cache-Control", "no-store"); res.json(response(result));
  } catch (error) { reportFailure(res, error); }
});

router.post(endpoint, async (req, res) => {
  const verified = await actor(req, res); if (!verified) return;
  if (!req.is("application/json") || req.header("sec-fetch-site") === "cross-site") {
    res.status(403).json({ error: "Hanya JSON dari Finance DEV" }); return;
  }
  const origin = req.header("origin");
  if (!origin || origin !== "https://" + req.header("host")) {
    res.status(403).json({ error: "Origin tidak sesuai" }); return;
  }
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 || req.body.reference !== reference) {
    res.status(422).json({ error: "Referensi pengujian harus PO #14" }); return;
  }
  try {
    const worker = await workerIdentity();
    const result = await withDb(async client => {
      const lock = await client.query("select pg_try_advisory_lock(166,14) as acquired");
      if (lock.rows[0]?.acquired !== true) return { busy: true as const };
      try {
        const existing = await readReceipt(client, worker.sha256, verified);
        if (existing) return { busy: false as const, receipt: existing, replay: true };
        const runId = randomUUID();
        const evidence = await executeWorker(worker.filename, verified, runId);
        if ((await workerIdentity()).sha256 !== worker.sha256) throw new Error("QA_WORKER_CHANGED");
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL statement_timeout='8000ms'");
          await client.query(`insert into public.qa_po14_real_e2e_runs
            (id,reference,company_id,actor,contract_version,amount,worker_sha256,evidence)
            values($1,$2,1,$3,2,100000.00,$4,$5::jsonb)`,
          [runId, reference, verified.email, worker.sha256, JSON.stringify(evidence)]);
          await client.query(`insert into public.qa_po14_real_e2e_audit(run_id,actor,action)
            values($1,$2,'real_service_sql_verified')`, [runId, verified.email]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
        return { busy: false as const, receipt: await readReceipt(client, worker.sha256, verified), replay: false };
      } finally { await client.query("select pg_advisory_unlock(166,14)").catch(() => undefined); }
    });
    if (result.busy) {
      res.status(409).json({ error: "Pengujian PO #14 sedang berjalan. Periksa ulang status setelah selesai.", code: "QA_RUNNING" }); return;
    }
    res.setHeader("Cache-Control", "no-store"); res.json(response(result.receipt, result.replay));
  } catch (error) { reportFailure(res, error); }
});

export default router;
