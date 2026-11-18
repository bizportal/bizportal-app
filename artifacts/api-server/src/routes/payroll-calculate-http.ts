import { Router, type IRouter } from "express";
import { authorizePayrollCompany } from "./payroll-access";
import { getProductionSession, getProductionUser, isSignedOtpDevEnabled } from "./dev-auth";
import { getPayrollPool, payrollDedicatedEnabled } from "./payroll-db";
import { calculateDevPayroll } from "./payroll-calculate";

/** Isolated DEV canary: signed OTP, exact company, exact Origin and restricted DB.
 * No legacy cookie, approval, accounting posting or payment side effects.
 */
const enabled = () => process.env.APP_ENV === "development" &&
  process.env.PAYROLL_DEV_CALCULATE_ENABLED === "true";
const positive = (raw: unknown): number | null => {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= 2147483647 ? n : null;
};
function validOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback = process.env.NODE_ENV === "test" && url.protocol === "http:" &&
      ["localhost","127.0.0.1"].includes(url.hostname);
    return (url.protocol === "https:" || loopback) &&
      url.origin === raw && url.pathname === "/" && !url.search && !url.hash &&
      !url.username && !url.password ? raw : null;
  } catch { return null; }
}
function errorStatus(error: unknown): [number,string] {
  const code = error instanceof Error ? error.message : "";
  if (code === "PAYROLL_CALCULATE_RUN_NOT_FOUND") return [404,"PAYROLL_NOT_FOUND"];
  if (/^PAYROLL_CALCULATE_(RUN_NOT_CLEAN_DRAFT|ROSTER_NOT_READY|PLAN_OR_ADVANCE_NOT_READY|GROSS_INCONSISTENT|DEDUCTIONS_EXCEED_GROSS|OLD_RESERVATION_MISMATCH|UNBACKED_KASBON_DEDUCTION|LEGACY_ALLOCATION_REQUIRES_RECONCILIATION|LEGACY_SCHEDULE_REQUIRES_RECONCILIATION)$/.test(code))
    return [409,"PAYROLL_CALCULATION_DATA_CONFLICT"];
  return [503,"PAYROLL_CALCULATION_UNAVAILABLE"];
}
export function createDevPayrollCalculateRouter(): IRouter {
  const router: IRouter = Router();
  if (!enabled()) return router;
  router.post("/payroll/runs/:id/calculate", async(req,res):Promise<void> => {
    res.setHeader("Cache-Control","no-store");
    if (!enabled()) { res.status(404).json({code:"NOT_FOUND"}); return; }
    try {
      if (!isSignedOtpDevEnabled()) { res.status(503).json({code:"SIGNED_OTP_UNAVAILABLE"}); return; }
      const session = getProductionSession(req);
      if (!session) { res.status(401).json({code:"AUTH_REQUIRED"}); return; }
      const actor = await getProductionUser(session);
      if (!actor || actor.role !== "super_admin") {
        res.status(403).json({code:"SUPER_ADMIN_REQUIRED"}); return;
      }
      const runId = positive(req.params.id),companyId = positive(req.query.companyId);
      if (!runId || !companyId || Object.keys(req.query).some(k=>k!=="companyId")) {
        res.status(400).json({code:"PAYROLL_SCOPE_INVALID"}); return;
      }
      if (authorizePayrollCompany(actor,req.query.companyId)!==companyId) {
        res.status(403).json({code:"PAYROLL_COMPANY_DENIED"}); return;
      }
      const origin = validOrigin(process.env.PAYROLL_DEV_CALCULATE_ALLOWED_ORIGIN?.trim());
      if (!origin) { res.status(503).json({code:"PAYROLL_ORIGIN_NOT_CONFIGURED"}); return; }
      if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
        res.status(403).json({code:"PAYROLL_ORIGIN_DENIED"}); return;
      }
      if (!req.is("application/json")) { res.status(415).json({code:"JSON_REQUIRED"}); return; }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
          Object.keys(req.body).length !== 0) {
        res.status(400).json({code:"PAYROLL_BODY_INVALID"}); return;
      }
      if (!payrollDedicatedEnabled()) {
        res.status(503).json({code:"PAYROLL_DEDICATED_DB_REQUIRED"}); return;
      }
      const result = await calculateDevPayroll(getPayrollPool(),companyId,runId);
      res.status(200).json({ok:true,...result});
    } catch(error) {
      const [status,code] = errorStatus(error);
      req.log?.warn?.({code},"DEV Payroll Calculate rejected");
      res.status(status).json({code});
    }
  });
  return router;
}
