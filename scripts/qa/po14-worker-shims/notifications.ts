/** Record suppressed intents; never enqueue messages into a business queue. */
import { pool } from "./db";
const writes: Array<Promise<unknown>> = [];
export function enqueueNotification(intent: Record<string, unknown>): Promise<number> {
  const write = pool.query(
    "insert into public.qa_worker_notification_intents(event_type,state) values($1,'suppressed') returning id",
    [String(intent.eventType ?? "unknown")],
  ).then(result => Number(result.rows[0].id));
  // Some canonical callers intentionally fire-and-forget. Attach a rejection
  // handler immediately; the original promise still fails the mandatory flush.
  void write.catch(() => undefined);
  writes.push(write);
  return write;
}
export async function flushSuppressedNotificationIntents(): Promise<void> {
  await Promise.all(writes);
}
