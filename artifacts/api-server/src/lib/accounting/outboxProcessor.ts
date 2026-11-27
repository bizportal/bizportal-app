/**
 * outboxProcessor.ts — RULE 3: Event Atomicity via Outbox Pattern
 *
 * Flow:
 *   1. Journal dibuat di accounting_entries
 *   2. Event ditulis ke financial_outbox_events (segera setelah insert)
 *   3. Worker polls outbox → proses event → tulis ke financial_events
 *   4. Outbox event ditandai 'done'
 *
 * Ini memastikan events TIDAK PERNAH hilang meskipun:
 * - Process crash setelah journal dibuat
 * - financial_events table sementara tidak tersedia
 * - Network timeout ke financialEventBus
 *
 * Worker berjalan setiap 10 detik, memproses batch 50 event.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";
import { registerHeartbeat, beat } from "../workerHeartbeat.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OutboxEventPayload {
  eventType:   string;
  entryId?:    number | null;
  sourceType?: string | null;
  sourceId?:   string | null;
  amount?:     number | null;
  actor?:      string | null;
  companyId?:  number | null;
  mutationId?: number | null;
  meta?:       Record<string, unknown> | null;
}

// ─── Migration ────────────────────────────────────────────────────────────────

let _migrated = false;

async function ensureOutboxTable(): Promise<void> {
  if (_migrated) return;
  _migrated = true;

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS financial_outbox_events (
      id           BIGSERIAL PRIMARY KEY,
      event_type   TEXT NOT NULL,
      payload      JSONB NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      entry_id     INTEGER,
      company_id   INTEGER,
      attempt      INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `).catch(() => {});

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS foe_status_idx ON financial_outbox_events(status) WHERE status = 'pending'
  `).catch(() => {});

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS foe_created_idx ON financial_outbox_events(created_at)
  `).catch(() => {});

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS foe_entry_idx ON financial_outbox_events(entry_id) WHERE entry_id IS NOT NULL
  `).catch(() => {});
}

// ─── Write to outbox ──────────────────────────────────────────────────────────

/**
 * writeToOutbox — Menulis event ke outbox segera setelah journal dibuat.
 * Non-blocking, best-effort. Dipanggil dari _postEntryCore() dalam accounting.ts.
 */
export async function writeToOutbox(payload: OutboxEventPayload): Promise<void> {
  await ensureOutboxTable();
  await db.execute(sql`
    INSERT INTO financial_outbox_events
      (event_type, payload, entry_id, company_id)
    VALUES (
      ${payload.eventType},
      ${JSON.stringify(payload)},
      ${payload.entryId ?? null},
      ${payload.companyId ?? null}
    )
  `).catch((e: unknown) => {
    logger.warn({ e, eventType: payload.eventType }, "[outbox] writeToOutbox failed (non-fatal)");
  });
}

// ─── Process outbox batch ─────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
const BATCH_SIZE   = 50;

/** Durable delivery: lock one row, use a savepoint for delivery, and retain
 * the lock until acknowledgement or retry is committed. No runtime DDL here.
 * The durable financial event is the delivery boundary; do not call the
 * legacy emitters, which themselves persist another financial event.
 */
export async function processOutboxBatch(): Promise<number> {
  let processed=0;
  for(let n=0;n<BATCH_SIZE;n++){
    const result=await db.transaction(async tx=>{
      const {rows}=await tx.execute(sql`
        SELECT id::text AS id,event_type,payload,entry_id,company_id,attempt
        FROM financial_outbox_events
        WHERE status='pending' AND attempt < ${MAX_ATTEMPTS}
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      `);
      const row=rows[0] as Record<string,unknown>|undefined;
      if(!row)return "empty" as const;
      const id=String(row.id);
      try {
        await tx.transaction(async delivery=>{
          const payload=(typeof row.payload==="string"?JSON.parse(row.payload):row.payload) as OutboxEventPayload;
          if(!payload || payload.eventType!==row.event_type || (payload.companyId??null)!==(row.company_id??null) || (payload.entryId??null)!==(row.entry_id??null))throw Error("OUTBOX_SCOPE_MISMATCH");
          // Write to financial_events (idempotent within the locked delivery transaction)
          await delivery.execute(sql`
            INSERT INTO financial_events
              (event_type,company_id,source_type,source_id,entry_id,mutation_id,amount,actor,ref,meta)
            VALUES(${payload.eventType},${payload.companyId??null},${payload.sourceType??null},
              ${payload.sourceId??null},${payload.entryId??null},${payload.mutationId??null},
              ${payload.amount??null},${payload.actor??null},${null},
              ${payload.meta?JSON.stringify(payload.meta):null})
          `);
          const ack=await delivery.execute(sql`
            UPDATE financial_outbox_events SET status='done',attempt=attempt+1,processed_at=now(),last_error=null
            WHERE id=${id}::bigint AND status='pending' RETURNING id
          `);
          if(ack.rows.length!==1)throw Error("OUTBOX_ACK_FAILED");
        });
        return "done" as const;
      }catch(err){
        // The savepoint has rolled back the event insert and acknowledgement.
        // Keep the outer row lock while recording the retry; never expose raw DB errors.
        logger.warn({id},"[outbox] delivery failed; retry retained");
        const retry=await tx.execute(sql`
          UPDATE financial_outbox_events
          SET status = 'pending', last_error='OUTBOX_DELIVERY_FAILED',attempt=attempt+1
          WHERE id=${id}::bigint AND status='pending' RETURNING id
        `);
        if(retry.rows.length!==1)throw Error("OUTBOX_RETRY_FAILED");
        return "retry" as const;
      }
    });
    if(result==="empty")break;
    if(result==="retry")break; // avoid exhausting retries in one poll
    processed++;
  }
  return processed;
}

// ─── Dead letter cleanup ──────────────────────────────────────────────────────

async function deadLetterCleanup(): Promise<void> {
  await db.execute(sql`
    UPDATE financial_outbox_events
    SET status = 'failed'
    WHERE status IN ('pending', 'processing')
      AND attempt >= ${MAX_ATTEMPTS}
      AND created_at < NOW() - INTERVAL '1 hour'
  `).catch(() => {});
}

// ─── Worker entry point ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS    = 10_000;  // poll setiap 10 detik
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // cleanup setiap 1 jam

let started=false;
let polling=false;
export function startOutboxProcessor(): void {
  if(started)return;
  started=true;
  registerHeartbeat("financial-outbox-processor", POLL_INTERVAL_MS);

  const tick=async()=>{
    if(polling)return;
    polling=true;
    try{beat("financial-outbox-processor");await processOutboxBatch();}
    catch{logger.warn("[outbox] poll failed");}
    finally{polling=false;}
  };
  setInterval(()=>void tick(),POLL_INTERVAL_MS).unref();
  setInterval(()=>void deadLetterCleanup(),CLEANUP_INTERVAL_MS).unref();
  setTimeout(()=>void tick(),5000).unref();

  logger.info(
    { pollIntervalSec: POLL_INTERVAL_MS / 1000 },
    "[outbox] Outbox processor started",
  );
}
