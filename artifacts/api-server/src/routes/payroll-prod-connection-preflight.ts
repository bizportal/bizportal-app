import type { IRouter, Request, Response } from "express";
import { pool } from "@workspace/db";
import { payrollReadOnlyReady, payrollProdSharedReadOnlyEnabled, payrollScopedQuery } from "./payroll-prod-db";
import { payrollReadinessSafeReason } from "./payroll-prod-readiness-error";
import { payrollDedicatedEnabled as devDedicatedEnabled, payrollScopedQuery as devScopedQuery } from "./payroll-db";
import { authorizePayrollCompany } from "./payroll-access";
import { getProductionSession, getProductionUser, isSignedOtpDevEnabled } from "./dev-auth";

type ScopedPayrollRequest = Request & {
  payrollCompanyId?: number;
  payrollActor?: { id: string; email: string; role: string; companyId: number | null };
};

/**
 * DEV uses the same existing preflight route, but NEVER a shared-pool fallback.
 * Diagnostic is opt-in and requires a revalidated signed-OTP Super Admin.
 * This intentionally does not inspect salaries, passwords, or perform writes.
 */
async function inspectDevConnection(req: ScopedPayrollRequest, res: Response): Promise<void> {
  if (process.env.PAYROLL_DEV_CONNECTION_PREFLIGHT_ENABLED !== "true") {
    res.status(404).json({ code: "PAYROLL_DEV_PREFLIGHT_DISABLED" });
    return;
  }
  if (!isSignedOtpDevEnabled()) {
    res.status(503).json({ ready: false, readOnly: true, code: "PAYROLL_DEV_SIGNED_OTP_NOT_READY" });
    return;
  }
  const session = getProductionSession(req);
  if (!session) {
    res.status(401).json({ code: "PAYROLL_DEV_SIGNED_SESSION_REQUIRED" });
    return;
  }
  let verified: Awaited<ReturnType<typeof getProductionUser>>;
  try { verified = await getProductionUser(session); }
  catch {
    res.status(503).json({ ready: false, readOnly: true, code: "PAYROLL_DEV_SESSION_VERIFICATION_UNAVAILABLE" });
    return;
  }
  const actor = req.payrollActor;
  const companyId = req.payrollCompanyId;
  if (!verified || verified.role !== "super_admin" || !actor ||
      actor.id !== verified.id || actor.email !== verified.email ||
      actor.role !== verified.role ||
      !Number.isSafeInteger(companyId) || !companyId || companyId <= 0 ||
      authorizePayrollCompany(verified, req.query.companyId) !== companyId) {
    res.status(403).json({ code: "PAYROLL_DEV_SUPER_ADMIN_REQUIRED" });
    return;
  }
  let configured: boolean;
  try { configured = devDedicatedEnabled(); }
  catch {
    res.status(503).json({ ready: false, readOnly: true, dedicatedConnectionVerified: false,
      code: "PAYROLL_DEV_DEDICATED_CONFIG_INVALID" });
    return;
  }
  if (!configured) {
    res.status(503).json({ ready: false, readOnly: true, dedicatedConnectionVerified: false,
      code: "PAYROLL_DEV_DEDICATED_NOT_CONFIGURED" });
    return;
  }
  try {
    // The existing adapter runs BEGIN READ ONLY, transaction-local company scope,
    // and COMMIT/ROLLBACK on the dedicated database connection only.
    const check = await devScopedQuery(companyId, [
      'SELECT current_user AS "dbRole", session_user AS "sessionRole",',
      "current_setting('app.payroll_company_id', true) AS \"companyScope\",",
      "current_setting('transaction_read_only') AS \"txReadOnly\",",
      '(SELECT count(*) FROM public.payroll_runs) AS "visibleRuns",',
      '(SELECT count(*) FROM public.payroll_salary_profiles) AS "visibleProfiles",',
      // All checks execute inside the same dedicated READ ONLY transaction.
      // A matching username alone is insufficient if the role acquired DDL,
      // membership or salary-payout write privileges after provisioning.
      '(SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls',
      'AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication',
      'AND NOT r.rolinherit AND NOT has_schema_privilege(r.oid, \'public\', \'CREATE\')',
      'AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)',
      'AND COALESCE(NOT (',
      "has_any_column_privilege(r.oid, to_regclass('public.salary_payments'), 'INSERT')",
      "OR has_any_column_privilege(r.oid, to_regclass('public.salary_payments'), 'UPDATE')",
      "OR has_table_privilege(r.oid, to_regclass('public.salary_payments'), 'DELETE')",
      "OR has_table_privilege(r.oid, to_regclass('public.salary_payments'), 'TRUNCATE')",
      '), false) FROM pg_roles r WHERE r.rolname=current_user) AS "restrictedRole"',
    ].join(" "), []);
    const row = check.rows[0];
    if (check.rowCount !== 1 || row?.dbRole !== "bizportal_payroll_dev" ||
        row?.sessionRole !== row.dbRole || row?.companyScope !== String(companyId) ||
        row?.txReadOnly !== "on" || row?.restrictedRole !== true) {
      res.status(503).json({ ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_DEV_ROLE_SCOPE_INVALID" });
      return;
    }
    res.json({
      ready: true, readOnly: true, dedicatedConnectionVerified: true,
      companyScopeVerified: true, roleVerified: true, diagnosticOnly: true,
      rlsPolicySemanticsVerified: false,
      canPay: false, canApprove: false, canPostJournal: false, canWriteKasbon: false,
    });
  } catch {
    res.status(503).json({ ready: false, readOnly: true, dedicatedConnectionVerified: false,
      code: "PAYROLL_DEV_DATABASE_READINESS_FAILED" });
  }
}

/**
 * Read-only proof of the actual dedicated Payroll PROD connection.
 * Existing Payroll authorization middleware runs before this route.
 * No feature flags are changed; no secret, employee, or monetary data returned.
 */
export function registerPayrollProdConnectionPreflightRoutes(router: IRouter): void {
  router.get("/payroll/connection-preflight", async (req: ScopedPayrollRequest, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const runtime = process.env.APP_ENV?.trim().toLowerCase();
    if (runtime === "development") {
      await inspectDevConnection(req, res);
      return;
    }
    if (runtime !== "production") {
      res.status(404).json({ message: "Pemeriksaan ini hanya tersedia di PROD." });
      return;
    }
    const companyId = req.payrollCompanyId;
    if (!Number.isSafeInteger(companyId) || !companyId || companyId <= 0) {
      res.status(403).json({ message: "Perusahaan Payroll tidak valid." });
      return;
    }
    const actor = req.payrollActor;
    const isSuperAdmin = actor?.role.trim().toLowerCase() === "super_admin";
    // CST's already-designated owner may inspect connection readiness only.
    // Resolve the signed account through its email; Supabase session.id may differ
    // from public.users.id. The database row ID itself remains strictly pinned.
    // This is NOT a general Owner privilege and does not alter any write/approval routes.
    const designatedOwner =
      companyId === 1 &&
      actor?.email.trim().toLowerCase() === "admcst001@gmail.com" &&
      actor.role.trim().toLowerCase() === "owner" &&
      actor.companyId === 1;
    let ownerVerified = false;
    if (!isSuperAdmin && designatedOwner) {
      try {
        // Recheck active DB identity. A revoked/suspended session must not pass.
        const active = await pool.query(
          `SELECT 1 FROM public.users WHERE id=$1 AND lower(btrim(email))=$2
             AND company_id=1 AND lower(btrim(role))='owner'
             AND is_active IS TRUE AND lower(btrim(status))='active' LIMIT 1`,
          ["google_103728868378401731050", "admcst001@gmail.com"],
        );
        ownerVerified = active.rowCount === 1;
      } catch {
        res.status(503).json({
          ready: false, readOnly: true, dedicatedConnectionVerified: false,
          code: "PAYROLL_PROD_OWNER_VERIFICATION_UNAVAILABLE",
        });
        return;
      }
    }
    if (!isSuperAdmin && !ownerVerified) {
      res.status(403).json({ message: "Pemeriksaan koneksi Payroll hanya untuk Super Admin atau Owner CST terverifikasi." });
      return;
    }

    let configured: boolean;
    try {
      configured = payrollReadOnlyReady();
    } catch (error) {
      // Explicit allowlist: never return the URL, password, username, host or raw DB error.
      const safeReasons = new Set([
        "PAYROLL_PROD_URL_MALFORMED",
        "PAYROLL_PROD_URL_SCHEME_INVALID",
        "PAYROLL_PROD_PROJECT_MISMATCH",
        "PAYROLL_PROD_USERNAME_MISMATCH",
        "PAYROLL_PROD_HOST_MISMATCH",
        "PAYROLL_PROD_POOLER_USERNAME_SUFFIX_REQUIRED",
        "PAYROLL_PROD_DATABASE_NAME_MISSING",
      ]);
      const rawReason=error instanceof Error ? error.message : "";
      res.status(503).json({
        ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_PROD_DEDICATED_CONFIG_INVALID",
        reasonCode: safeReasons.has(rawReason) ? rawReason : "PAYROLL_PROD_URL_MALFORMED",
      });
      return;
    }
    if (!configured) {
      res.status(503).json({
        ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_PROD_DEDICATED_NOT_CONFIGURED",
      });
      return;
    }

    try {
      // payrollScopedQuery always uses BEGIN READ ONLY + SET LOCAL ROLE
      // + transaction-local company scope, followed by COMMIT/ROLLBACK.
      // COUNT probes verify SELECT capability without returning employee data.
      const result = await payrollScopedQuery(companyId, [
        'SELECT current_user AS "dbRole",',
        'current_setting(\'app.payroll_company_id\', true) AS "companyScope",',
        '(SELECT COUNT(*) FROM public.payroll_runs) AS "visibleRuns",',
        '(SELECT COUNT(*) FROM public.payroll_salary_profiles) AS "visibleProfiles"',
      ].join(" "), []);
      const record = result.rows[0];
      const verified = result.rowCount === 1 &&
        record?.dbRole === "bizportal_payroll_prod" &&
        record?.companyScope === String(companyId);
      if (!verified) {
        res.status(503).json({
          ready: false, readOnly: true, dedicatedConnectionVerified: false,
          code: "PAYROLL_PROD_ROLE_OR_SCOPE_INVALID",
        });
        return;
      }
      const shared=payrollProdSharedReadOnlyEnabled();
      res.status(200).json({
        ready: true,
        readOnly: true,
        connectionMode: shared ? "BIZPORTAL_SHARED_ROLE_SCOPED_READ_ONLY" : "DEDICATED_ROLE_SCOPED_READ_ONLY",
        dedicatedConnectionVerified: !shared,
        sharedRoleScopedVerified: shared,
        companyScopeVerified: true,
        roleVerified: true,
        canPay: false,
        canPostJournal: false,
        canApprove: false,
        canWriteKasbon: false,
      });
    } catch (error) {
      // Deliberately do not serialize DB errors, URLs, credentials, query text or
      // the failing SQL. Only a predefined, non-sensitive diagnosis is returned.
      res.status(503).json({
        ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_PROD_DATABASE_READINESS_FAILED",
        reasonCode: payrollReadinessSafeReason(error),
      });
    }
  });
}
