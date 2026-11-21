import { Router, type Request, type Response } from "express";
import {
  getProductionSession,
  getProductionUser,
  isSignedOtpDevEnabled,
} from "./dev-auth";
import { getDevBankSheetReaderFromConfiguredSource } from "../lib/bankSheetScopedReader";

/**
 * Explicitly opt-in, READ ONLY release evidence endpoint for PR147.
 * Real signed OTP cookie only, revalidated against canonical DB on each call.
 * Never authorize with the legacy DEV email allowlist or user-supplied role.
 * No mutation, token issuance, session export, or application approval.
 */
const router = Router();

router.get("/pr147/verify-super-admin", async (req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  if (
    process.env.APP_ENV !== "development"
    || process.env.PR147_SIGNED_VERIFY_ENABLED_DEV !== "true"
  ) {
    res.status(404).json({ code: "PR147_VERIFICATION_DISABLED" });
    return;
  }
  if (!isSignedOtpDevEnabled()) {
    res.status(503).json({ code: "PR147_SIGNED_OTP_UNAVAILABLE" });
    return;
  }
  const session = getProductionSession(req);
  if (!session) {
    res.status(401).json({ code: "PR147_SIGNED_SESSION_REQUIRED" });
    return;
  }

  let actor: Awaited<ReturnType<typeof getProductionUser>>;
  try {
    actor = await getProductionUser(session);
  } catch {
    res.status(503).json({ code: "PR147_ACTOR_REVALIDATION_UNAVAILABLE" });
    return;
  }
  if (!actor || actor.role.trim().toLowerCase() !== "super_admin") {
    res.status(403).json({ code: "PR147_SUPER_ADMIN_REQUIRED" });
    return;
  }
  // A company-bound account may not escalate into an all-company release
  // verifier. Owner Super Admin must have explicit global scope (null).
  if (actor.companyId !== null) {
    res.status(403).json({ code: "PR147_GLOBAL_OWNER_SCOPE_REQUIRED" });
    return;
  }

  try {
    const companyResults: Array<{ companyId: number; status: "PASS"; configCount: number }> = [];
    for (const companyId of [1, 3]) {
      const reader = await getDevBankSheetReaderFromConfiguredSource(companyId);
      const principal = await reader.query<{
        actor: string; session_actor: string; sheet_rls: boolean;
        bank_rls: boolean; can_read: boolean; can_write: boolean;
      }>(`SELECT current_user AS actor, session_user AS session_actor,
          row_security_active('public.bank_sheet_configs'::regclass) AS sheet_rls,
          row_security_active('public.company_bank_accounts'::regclass) AS bank_rls,
          has_table_privilege(current_user,'public.bank_sheet_configs','SELECT') AS can_read,
          has_table_privilege(current_user,'public.bank_sheet_configs','INSERT,UPDATE,DELETE') AS can_write`);
      const status = principal.rows[0];
      const expected = companyId === 1 ? "bizportal_finance_cst_login_dev" : "bizportal_finance_diva_login_dev";
      if (!status || ![expected, expected + ".xssrfshdrtdfupgqwfdw"].includes(status.actor)
          || status.actor !== status.session_actor || !status.sheet_rls
          || !status.bank_rls || !status.can_read || status.can_write) {
        throw new Error("PR147_READER_SECURITY_GATE_FAILED");
      }
      const result = await reader.query<{ company_id: number }>(
        "SELECT company_id FROM public.bank_sheet_configs ORDER BY company_id",
      );
      if (result.rows.some(row => Number(row.company_id) !== companyId)
          || (companyId === 1 && result.rows.length !== 2)) {
        throw new Error("PR147_COMPANY_SCOPE_GATE_FAILED");
      }
      companyResults.push({ companyId, status: "PASS", configCount: result.rows.length });
    }

    res.status(200).json({
      code: "PR147_SIGNED_SUPER_ADMIN_READER_PASS",
      evidenceLevel: "REAL_SIGNED_USER_AND_READ_ONLY_DATABASE",
      verifiedAt: new Date().toISOString(),
      checks: { signedSuperAdmin: "PASS", tenantRls: "PASS", writeDenied: "PASS" },
      companies: companyResults,
      historicalMutationsPreserved: "OWNER_APPROVED_NO_CHANGE_POLICY",
      productionCutoverApproved: false,
    });
  } catch {
    // Never return backend URLs, password-bearing driver errors, or bank data.
    res.status(503).json({ code: "PR147_READONLY_E2E_NOT_VERIFIED", productionCutoverApproved: false });
  }
});

export default router;
