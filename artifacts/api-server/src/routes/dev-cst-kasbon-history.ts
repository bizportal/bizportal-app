import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getProductionSession, getProductionUser, isSignedOtpDevEnabled } from "./dev-auth";
import { DEV_CST_KASBON_HISTORY_SQL } from "./dev-cst-kasbon-history-sql";

const router: IRouter = Router();

// Separate DEV GET; never fall back to the production Payroll reader, widen
// its permissions, or mount a financial mutation. Existing OTP session only.
router.get("/advances/dev-kasbon-history", async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  if (process.env.APP_ENV !== "development" || !isSignedOtpDevEnabled()) {
    res.status(404).json({ error: "Not found" }); return;
  }
  const session = getProductionSession(req);
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (req.query.companyId !== "1" || Object.keys(req.query).some(k => k !== "companyId" && k !== "page")) {
    res.status(403).json({ error: "CST company 1 must be selected explicitly." }); return;
  }
  const raw = req.query.page ?? "1";
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 10000) {
    res.status(400).json({ error: "Invalid page." }); return;
  }
  const page = Number(raw);
  try {
    const actor = await getProductionUser(session);
    if (!actor || !["owner","super_admin"].includes(actor.role) ||
        (actor.companyId !== null && actor.companyId !== 1) ||
        actor.id !== session.id || actor.email !== session.email) {
      res.status(403).json({ error: "Finance company scope denied." }); return;
    }
    const result = await pool.query<{authorized: boolean; total: number; records: unknown}>(
      DEV_CST_KASBON_HISTORY_SQL, [actor.id, actor.email, actor.role, (page - 1) * 50],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || row?.authorized !== true) {
      res.status(403).json({ error: "Finance company scope no longer active." }); return;
    }
    if (!Number.isSafeInteger(row.total) || row.total < 0 || !Array.isArray(row.records) ||
        row.records.length !== Math.min(50, Math.max(0, row.total - (page - 1) * 50))) {
      res.status(503).json({ error: "Kasbon history unavailable." }); return;
    }
    res.json({ companyId: 1, readOnly: true, page, pageSize: 50, total: row.total, records: row.records });
  } catch {
    req.log?.error("CST-DEV kasbon history unavailable");
    res.status(503).json({ error: "Kasbon history unavailable." });
  }
});
export default router;
