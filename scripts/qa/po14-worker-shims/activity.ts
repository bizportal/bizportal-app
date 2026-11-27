/** Preserve service activity evidence inside the disposable database only. */
import { pool } from "./db";
export async function logActivity(activity: Record<string, unknown>): Promise<void> {
  await pool.query(
    "insert into public.qa_worker_activity(action,payload) values($1,$2::jsonb)",
    [String(activity.action ?? "unknown"), JSON.stringify(activity)],
  );
}
