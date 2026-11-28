import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getProductionSession, getProductionUser, isSignedOtpDevEnabled } from "./dev-auth";
import { AI_TASK_KASBON_READ_SQL } from "./ai-task-kasbon-read-sql";

const router: IRouter = Router();

// Finance status is read using BizPortal's existing signed OTP session, not
// the AI Task token or its legacy default/null tenant identity. No new grant.
// Existing finance dashboard scope permits an unbound Owner/Super Admin to
// select a company explicitly. Here the only selectable company is CST 1.
router.get("/advances/ai-task-reconciliation", async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  if (process.env.APP_ENV !== "development" || !isSignedOtpDevEnabled()) {
    res.status(404).json({ error: "Not found" }); return;
  }
  const session = getProductionSession(req);
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (req.query.companyId !== "1" || Object.keys(req.query).length !== 1) {
    res.status(403).json({ error: "CST company 1 must be selected explicitly." }); return;
  }
  try {
    const actor = await getProductionUser(session);
    if (!actor || !["owner", "super_admin"].includes(actor.role) ||
        (actor.companyId !== null && actor.companyId !== 1) ||
        actor.id !== session.id || actor.email !== session.email) {
      res.status(403).json({ error: "Finance company scope denied." }); return;
    }
    // The existing pool resolves the explicitly selected DEV project and
    // rejects the opposite project. No secondary connection or credentials.
    const result = await pool.query<{
      authorized: boolean; truncated: boolean; records: unknown;
    }>(AI_TASK_KASBON_READ_SQL, [actor.id, actor.email, actor.role]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row?.authorized !== true) {
      res.status(403).json({ error: "Finance company scope no longer active." }); return;
    }
    if (!Array.isArray(row.records) || row.records.length > 100 || typeof row.truncated !== "boolean") {
      res.status(503).json({ error: "Reconciliation data unavailable." }); return;
    }
    res.json({ companyId: 1, records: row.records, truncated: row.truncated });
  } catch {
    // Bounded message only; do not log employee data or SQL parameters.
    req.log?.error("AI Task kasbon reconciliation unavailable");
    res.status(503).json({ error: "Reconciliation data unavailable." });
  }
});

export default router;
