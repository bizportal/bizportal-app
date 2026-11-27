import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getProductionSession, getProductionUser, isSignedOtpDevEnabled } from "./dev-auth";
import { DEV_KASBON_GENERAL_READ_SQL } from "./dev-kasbon-general-read-sql";

const router: IRouter = Router();
const PAGE_SIZE = 50;

// Separate DEV GET only. Never change the production historical reader or
// its auth, and never accept an AI Task token or implicit company selection.
router.get("/advances/dev-kasbon-list", async (req, res): Promise<void> => {
  res.set("Cache-Control", "private, no-store");
  if (process.env.APP_ENV !== "development" || !isSignedOtpDevEnabled()) {
    res.status(404).json({ error: "Not found" }); return;
  }
  const session = getProductionSession(req);
  if (!session) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (req.query.companyId !== "1" || Object.keys(req.query).length !== 2) {
    res.status(403).json({ error: "CST company 1 must be selected explicitly." }); return;
  }
  const rawPage = req.query.page;
  if (typeof rawPage !== "string" || !/^[1-9][0-9]{0,4}$/.test(rawPage)) {
    res.status(400).json({ error: "Invalid page." }); return;
  }
  const page = Number(rawPage);
  if (!Number.isSafeInteger(page) || page > 10000) {
    res.status(400).json({ error: "Invalid page." }); return;
  }
  try {
    const actor = await getProductionUser(session);
    if (!actor || !["owner", "super_admin"].includes(actor.role) ||
        (actor.companyId !== null && actor.companyId !== 1) ||
        actor.id !== session.id || actor.email !== session.email) {
      res.status(403).json({ error: "Finance company scope denied." }); return;
    }
    const offset = (page - 1) * PAGE_SIZE;
    // Existing DEV pool and current account rechecked in same SELECT snapshot.
    const result = await pool.query<{authorized:boolean; total:string; records:unknown}>(
      DEV_KASBON_GENERAL_READ_SQL, [actor.id, actor.email, actor.role, offset],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || row?.authorized !== true) {
      res.status(403).json({ error: "Finance company scope no longer active." }); return;
    }
    const total = typeof row.total === "string" && /^\d+$/.test(row.total) ? Number(row.total) : NaN;
    if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(row.records) ||
        row.records.length !== Math.min(PAGE_SIZE, Math.max(0,total-offset))) {
      res.status(503).json({ error: "Kasbon data unavailable." }); return;
    }
    res.json({ companyId:1, page, pageSize:PAGE_SIZE, total, readOnly:true, records:row.records });
  } catch {
    req.log?.error("DEV kasbon general read unavailable");
    res.status(503).json({ error: "Kasbon data unavailable." });
  }
});
export default router;
