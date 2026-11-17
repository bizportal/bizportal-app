import { Router, type IRouter, type Request, type Response } from "express";
import type { Pool } from "pg";
import { authorizePayrollCompany } from "./payroll-access";
import { verifyPayrollSettlementRuntime } from "./payroll-accounting-runtime-preflight";
import { getProductionSession, getProductionUser, isSignedOtpDevEnabled } from "./dev-auth";
import { postReviewedPayrollAccrualTransaction, type TransactionBoundPayrollWriter } from "./payroll-accounting-transaction";

/** No credentials or fallback pool are loaded here. Only trusted server bootstrap
 * can bind the separately provisioned settlement pool + patched native service.
 * A route cannot accept a pool, writer, origin, actor or account from its body.
 * Default OFF, absent in PROD, no new human approval or salary disbursement.
 */
export interface PayrollAtomicHttpBinding {
  pool: Pick<Pool, "connect">;
  writer: TransactionBoundPayrollWriter;
  allowedOrigin: string;
}
let runtime: Readonly<PayrollAtomicHttpBinding> | null = null;
let pendingBinding: { binding: Readonly<PayrollAtomicHttpBinding>; completion: Promise<void> } | null = null;
const enabled = () => process.env.APP_ENV === "development" &&
  process.env.PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED === "true" &&
  process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED === "true";

function validatedOrigin(value: string): string {
  const u = new URL(value);
  const testLoopback = process.env.NODE_ENV === "test" && u.protocol === "http:" &&
    (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if ((!testLoopback && u.protocol !== "https:") || u.origin !== value ||
      u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw Error("PAYROLL_HTTP_ORIGIN_INVALID");
  return u.origin;
}

/** Idempotent binding of the SAME objects only; changing a running financial
 * binding requires controlled restart. This export is not exposed as an API.
 */
export async function bindDevPayrollAtomicHttpRuntime(binding: PayrollAtomicHttpBinding): Promise<void> {
  if (!enabled()) throw Error("PAYROLL_HTTP_DEV_DISABLED");
  if (!binding?.pool || typeof binding.pool.connect !== "function" ||
      binding.writer?.transactionalAccrualVersion !== "payroll-accrual-atomic-v1" ||
      typeof binding.writer.postAccrualJournal !== "function")
    throw Error("PAYROLL_HTTP_BINDING_INVALID");
  const origin = validatedOrigin(binding.allowedOrigin);
  const same = (prior: Readonly<PayrollAtomicHttpBinding>) =>
    prior.pool === binding.pool && prior.writer === binding.writer && prior.allowedOrigin === origin;
  if (runtime) {
    if (!same(runtime)) throw Error("PAYROLL_HTTP_REBIND_REQUIRES_RESTART");
    return;
  }
  if (pendingBinding) {
    if (!same(pendingBinding.binding)) throw Error("PAYROLL_HTTP_REBIND_REQUIRES_RESTART");
    return pendingBinding.completion;
  }
  const candidate = Object.freeze({ pool: binding.pool, writer: binding.writer, allowedOrigin: origin });
  const completion = (async () => {
    await verifyPayrollSettlementRuntime(candidate.pool);
    if (!enabled()) throw Error("PAYROLL_HTTP_DEV_DISABLED");
    runtime = candidate;
  })();
  pendingBinding = { binding: candidate, completion };
  try { await completion; }
  finally { if (pendingBinding?.completion === completion) pendingBinding = null; }
}

const positive = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= 2147483647 ? n : null;
};
function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^20\d\d-(0[1-9]|1[0-2])-[0-3]\d$/.test(value)) return false;
  const time = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function safeFailure(error: unknown): { status: number; code: string; message: string } {
  const code = error instanceof Error ? error.message : "";
  if (code === "PAYROLL_ATOMIC_RUN_NOT_FOUND_IN_COMPANY")
    return { status: 404, code: "PAYROLL_NOT_FOUND", message: "Payroll tidak ditemukan pada perusahaan terpilih." };
  if (code === "PAYROLL_ATOMIC_APPROVAL_RECEIPT_MISMATCH")
    return { status: 409, code: "PAYROLL_APPROVAL_CHANGED", message: "Bukti persetujuan tidak cocok. Muat ulang Payroll." };
  const guarded = ["PAYROLL_ATOMIC_APPROVED_ITEMS_CHANGED", "PAYROLL_ATOMIC_RUN_STATE_NOT_POSTABLE",
    "PAYROLL_ATOMIC_PAYMENT_ALREADY_LINKED", "PAYROLL_ATOMIC_JOURNAL_NOT_VERIFIED", "PAYROLL_ATOMIC_JOURNAL_LINES_CHANGED",
    "PAYROLL_ATOMIC_OTHER_DEDUCTION_MAPPING_REQUIRED", "PAYROLL_HANDOFF_OTHER_DEDUCTION_MAPPING_REQUIRED",
    "PAYROLL_ATOMIC_LEGACY_ALLOCATIONS_REQUIRE_RECONCILIATION",
    "PAYROLL_ATOMIC_LEGACY_INSTALLMENT_SCHEDULE_REQUIRES_RECONCILIATION",
    "PAYROLL_ATOMIC_POSTING_PERIOD_CLOSED", "PAYROLL_ATOMIC_POSTING_PERIOD_NOT_CONFIGURED",
    "PAYROLL_ATOMIC_ADVANCE_BALANCE_CHANGED", "PAYROLL_ATOMIC_MAPPING_NOT_UNIQUE_OR_COMPLETE",
    "PAYROLL_ATOMIC_REPAYMENT_LEDGER_COUNT_CHANGED", "PAYROLL_ATOMIC_REPAYMENT_LEDGER_NOT_VERIFIED",
    "PAYROLL_ATOMIC_UNLINKED_JOURNAL_REQUIRES_RECOVERY"];
  if (guarded.includes(code)) return { status: 409, code: "PAYROLL_INTEGRITY_BLOCKED",
    message: "Posting ditolak karena data atau bukti Payroll belum sesuai." };
  // Never reflect database SQL, connection strings, raw errors, actor or salaries.
  return { status: 503, code: "PAYROLL_POSTING_UNAVAILABLE", message: "Posting Payroll belum tersedia atau gagal. Periksa status sebelum mencoba ulang." };
}

export function createPayrollAtomicAccountingRouter(): IRouter {
  const router: IRouter = Router();
  if (!enabled()) return router;
  router.post("/payroll/runs/:id/post-accounting", async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    // Recheck after registration: disabling a gate cannot leave a writer live.
    if (!enabled()) { res.status(404).json({ code: "NOT_FOUND" }); return; }
    try {
      if (!isSignedOtpDevEnabled()) {
        res.status(503).json({ code: "PAYROLL_SIGNED_SESSION_NOT_READY" }); return;
      }
      const session = getProductionSession(req);
      if (!session) { res.status(401).json({ code: "AUTH_REQUIRED" }); return; }
      const actor = await getProductionUser(session);
      if (!actor || actor.role !== "super_admin") { res.status(403).json({ code: "SUPER_ADMIN_REQUIRED" }); return; }
      const runId = positive(req.params.id), selected = positive(req.query.companyId);
      if (!runId || !selected || Object.keys(req.query).some(key => key !== "companyId")) {
        res.status(400).json({ code: "PAYROLL_SCOPE_INVALID" }); return;
      }
      const companyId = authorizePayrollCompany(actor, req.query.companyId);
      if (companyId !== selected) { res.status(403).json({ code: "PAYROLL_COMPANY_DENIED" }); return; }
      const binding = runtime;
      if (!binding) { res.status(503).json({ code: "PAYROLL_RUNTIME_NOT_BOUND" }); return; }
      if (req.headers.origin !== binding.allowedOrigin || req.headers["sec-fetch-site"] === "cross-site") {
        res.status(403).json({ code: "PAYROLL_ORIGIN_DENIED" }); return;
      }
      if (!req.is("application/json")) { res.status(415).json({ code: "JSON_REQUIRED" }); return; }
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some(key => key !== "expectedDigest" && key !== "postingDate") ||
          typeof body.expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedDigest) ||
          !calendarDate(body.postingDate)) {
        res.status(400).json({ code: "PAYROLL_REQUEST_INVALID" }); return;
      }
      const result = await postReviewedPayrollAccrualTransaction(binding.pool, binding.writer, {
        companyId, runId, postingDate: body.postingDate, expectedDigest: body.expectedDigest,
        actor: { id: actor.id, email: actor.email, role: actor.role },
      });
      res.status(200).json({ ok: true, runId, companyId, entryId: result.entryId,
        reused: result.reused, accountingPosted: true, salaryPaid: false });
    } catch (error) {
      const failure = safeFailure(error);
      req.log?.warn?.({ code: failure.code }, "DEV Payroll accounting request denied or failed");
      res.status(failure.status).json({ code: failure.code, message: failure.message });
    }
  });
  return router;
}
