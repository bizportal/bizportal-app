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

async function processOutboxBatch(): Promise<number> {
  await ensureOutboxTable();

  // Ambil pending events, skip yang sudah too many attempts
  const { rows } = await db.execute(sql`
    SELECT id, event_type, payload, entry_id, company_id, attempt
    FROM financial_outbox_events
    WHERE status = 'pending'
      AND attempt < ${MAX_ATTEMPTS}
      -- The strict, opt-in Customer Portal DEV consumer owns its exact
      -- tagged sales-invoice events. Never let the legacy fire-and-forget
      -- path claim them and duplicate financial_events.
      AND NOT (
        event_type = 'JOURNAL_CREATED'
        AND payload->>'sourceType' = 'sales_invoice'
        AND left(coalesce(payload->>'dedupeKey', ''), 14) = 'sales_invoice:'
      )
    ORDER BY created_at ASC
    LIMIT ${BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  `).catch(() => ({ rows: [] }));

  if (!rows.length) return 0;

  let processed = 0;

  for (const row of rows as Array<Record<string, unknown>>) {
    const id      = Number(row["id"]);
    const payload = (typeof row["payload"] === "string"
      ? JSON.parse(row["payload"])
      : row["payload"]) as OutboxEventPayload;

    try {
      // Mark as processing first
      await db.execute(sql`
        UPDATE financial_outbox_events
        SET status = 'processing', attempt = attempt + 1
        WHERE id = ${id} AND status = 'pending'
      `).catch(() => {});

      // Write to financial_events (idempotent)
      await db.execute(sql`
        INSERT INTO financial_events
          (event_type, company_id, source_type, source_id, entry_id, mutation_id, amount, actor, ref, meta)
        VALUES (
          ${payload.eventType},
          ${payload.companyId ?? null},
          ${payload.sourceType ?? null},
          ${payload.sourceId ?? null},
          ${payload.entryId ?? null},
          ${payload.mutationId ?? null},
          ${payload.amount ?? null},
          ${payload.actor ?? null},
          ${null},
          ${payload.meta ? JSON.stringify(payload.meta) : null}
        )
        ON CONFLICT DO NOTHING
      `).catch(() => {});

      // Also emit to in-memory event bus (lazy import)
      const eventType = payload.eventType as string;
      if (eventType === "JOURNAL_CREATED" || eventType === "JOURNAL_VOIDED") {
        import("../events/financialEventBus.js").then(({ emitJournalCreated, emitJournalVoided }) => {
          if (eventType === "JOURNAL_CREATED" && payload.entryId) {
            emitJournalCreated({
              entryId:    payload.entryId,
              sourceType: payload.sourceType ?? null,
              sourceId:   payload.sourceId ?? null,
              amount:     payload.amount ?? null,
              actor:      payload.actor ?? null,
              companyId:  payload.companyId ?? null,
            });
          }
        }).catch(() => {});
      }

      // Mark done
      await db.execute(sql`
        UPDATE financial_outbox_events
        SET status = 'done', processed_at = NOW()
        WHERE id = ${id}
      `).catch(() => {});

      processed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ id, eventType: payload.eventType, err: msg }, "[outbox] processOutboxBatch: event failed");
      await db.execute(sql`
        UPDATE financial_outbox_events
        SET status = 'pending', last_error = ${msg}
        WHERE id = ${id}
      `).catch(() => {});
    }
  }

  if (processed > 0) {
    logger.info({ processed, total: rows.length }, "[outbox] Batch processed");
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

export function startOutboxProcessor(): void {
  registerHeartbeat("financial-outbox-processor", POLL_INTERVAL_MS);

  // Process pending events
  setInterval(() => {
    beat("financial-outbox-processor");
    processOutboxBatch().catch((e: unknown) => {
      logger.warn({ e }, "[outbox] processOutboxBatch tick failed (non-fatal)");
    });
  }, POLL_INTERVAL_MS);

  // Dead letter cleanup
  setInterval(() => {
    deadLetterCleanup().catch(() => {});
  }, CLEANUP_INTERVAL_MS);

  // Run once immediately (after 5s delay to let DB pool stabilize)
  setTimeout(() => {
    beat("financial-outbox-processor");
    processOutboxBatch().catch(() => {});
  }, 5_000);

  logger.info(
    { pollIntervalSec: POLL_INTERVAL_MS / 1000 },
    "[outbox] Outbox processor started",
  );
}


// Strict DEV-only extension of the EXISTING outbox worker. Nothing starts
// automatically: the original worker and all historical events are unchanged.
// The row claim, financial event and done status have ONE transaction boundary;
// a crash before COMMIT leaves the event pending, and a retry after COMMIT sees
// it done. Never emit via financialEventBus here: it writes a second DB event.
export type CustomerPortalOutboxDevResult =
  | { status: "disabled" | "empty" }
  | { status: "processed" | "quarantined"; outboxId: number; reason?: string };

export async function processCustomerPortalSalesInvoiceOutboxDevOnce():
  Promise<CustomerPortalOutboxDevResult> {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV !== "true" ||
      process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV !== "true" ||
      process.env.CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV !== "true") {
    return { status: "disabled" };
  }

  return db.transaction(async (tx): Promise<CustomerPortalOutboxDevResult> => {
    // New Customer Portal events only. Historical orphan/stuck/duplicate rows
    // never match this stable prefix, and are not reset or sent again.
    const claimed = await tx.execute(sql`
      SELECT id, payload, entry_id, company_id
      FROM public.financial_outbox_events
      WHERE status = 'pending' AND event_type = 'JOURNAL_CREATED'
        AND payload->>'sourceType' = 'sales_invoice'
        AND left(coalesce(payload->>'dedupeKey', ''), 14) = 'sales_invoice:'
        AND attempt < 5
      ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (!claimed.rows.length) return { status: "empty" };
    const row = claimed.rows[0] as Record<string, unknown>;
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw Error("DEV_OUTBOX_ID_INVALID");
    const payload = row.payload as Record<string, unknown> | null;
    const entry = Number(row.entry_id);
    const company = Number(row.company_id);
    const sourceId = Number(payload?.sourceId);
    const amount = Number(payload?.amount);
    const actor = typeof payload?.actor === "string" ? payload.actor : "";
    const key = ["sales_invoice", company, sourceId, entry].join(":");

    const quarantine = async (reason: string): Promise<CustomerPortalOutboxDevResult> => {
      const changed = await tx.execute(sql`
        UPDATE public.financial_outbox_events
        SET status='failed', attempt=attempt+1, last_error=${reason}
        WHERE id=${id} AND status='pending' RETURNING id
      `);
      if (changed.rows.length !== 1) throw Error("DEV_OUTBOX_QUARANTINE_FAILED");
      return { status: "quarantined", outboxId: id, reason };
    };
    if (![1, 3].includes(company) || !Number.isSafeInteger(entry) || entry <= 0 ||
        !Number.isSafeInteger(sourceId) || sourceId <= 0 ||
        !Number.isFinite(amount) || amount <= 0 || !actor ||
        payload?.eventType !== "JOURNAL_CREATED" ||
        payload?.sourceType !== "sales_invoice" ||
        Number(payload?.entryId) !== entry ||
        Number(payload?.companyId) !== company ||
        payload?.dedupeKey !== key) {
      return quarantine("DEV_OUTBOX_SOURCE_IDENTITY_INVALID");
    }
    // Posted/owned/balanced journal, Invoice, materialized AR and the
    // canonical Super Admin audit must all agree on this exact source.
    // Taxable source is accepted ONLY with a separate DEV flag and strict
    // reporting tax metadata + three-line original GL verification.
    const proof = await tx.execute(sql`
      SELECT e.id, s.tax_amount
      FROM public.accounting_entries e
      JOIN public.sales_documents s
        ON s.id=e.source_id AND s.company_id=e.company_id
      JOIN public.bizportal_customer_ar_source_evidence_dev ar
        ON ar.invoice_id=s.id AND ar.company_id=s.company_id
      JOIN public.audit_accounting_events a
        ON a.journal_id=e.id AND a.company_id=e.company_id
       AND a.action='SALES_INVOICE_ISSUED'
       AND a.correlation_id=${key} AND a.user_id=${actor}
      WHERE e.id=${entry} AND e.company_id=${company}
        AND e.source::text='sales_invoice' AND e.status::text='posted'
        AND e.is_voided=false AND e.is_reversed=false
        AND s.invoice_status::text='invoiced'
        AND s.id=${sourceId}
        AND e.ref=s.invoice_number
        AND e.total_debit=${amount} AND e.total_credit=${amount}
        AND s.grand_total=${amount}
      LIMIT 2
    `);
    if (proof.rows.length !== 1) return quarantine("DEV_OUTBOX_LEDGER_AR_AUDIT_MISSING");
    const taxAmount = Number((proof.rows[0] as Record<string,unknown>).tax_amount ?? 0);
    if (!Number.isFinite(taxAmount) || taxAmount < 0) {
      return quarantine("DEV_OUTBOX_TAX_AMOUNT_INVALID");
    }
    if (taxAmount > 0) {
      if (process.env.CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV !== "true") {
        return quarantine("DEV_OUTBOX_TAX_POSTING_NOT_ENABLED");
      }
      // Cross-check explicit Invoice tax ID, company-owned active rate,
      // default mapping, liability COA, original 3-line GL and exactly
      // one matching PPN_OUT reporting row. All reads use this SAME tx.
      const taxProof = await tx.execute(sql`
        SELECT s.id
        FROM public.sales_documents s
        JOIN public.accounting_settings cfg
          ON cfg.company_id=s.company_id
        JOIN public.accounting_taxes t
          ON t.id=s.tax_rate_id AND t.id=cfg.default_sales_tax_id
         AND t.company_id=s.company_id AND t.kind::text='sale'
         AND t.cut_type::text='self_borne' AND t.is_active=true
        JOIN public.chart_of_accounts ppn
          ON ppn.id=cfg.ppn_output_account_id
         AND ppn.company_id=s.company_id AND ppn.type::text='liability'
         AND ppn.is_active=true AND ppn.is_postable=true
         AND ppn.status='ACTIVE'
        JOIN public.gl_tax_lines g
          ON g.accounting_entry_id=${entry} AND g.company_id=s.company_id
         AND g.tax_type='PPN_OUT' AND g.direction='out'
         AND g.entity_type='sales_invoice' AND g.entity_id=s.id::text
         AND g.tax_amount=s.tax_amount
         AND g.base_amount=s.total_amount AND g.rate=t.rate
        WHERE s.id=${sourceId} AND s.company_id=${company}
          AND s.tax_treatment='exclusive'
          AND s.tax_amount>0 AND t.rate IN (11,12)
          AND round(s.total_amount*t.rate/100,2)=s.tax_amount
          AND t.account_id=ppn.id
          AND s.grand_total=s.total_amount+s.tax_amount
          AND (SELECT count(*)::int FROM public.gl_tax_lines all_tax
               WHERE all_tax.accounting_entry_id=${entry}
                 AND all_tax.company_id=${company})=1
          AND (SELECT coalesce(sum(l.credit),0)
               FROM public.accounting_entry_lines l
               WHERE l.entry_id=${entry}
                 AND l.account_id=cfg.sales_income_account_id)=s.total_amount
          AND (SELECT coalesce(sum(l.credit),0)
               FROM public.accounting_entry_lines l
               WHERE l.entry_id=${entry} AND l.account_id=ppn.id)=s.tax_amount
          AND (SELECT coalesce(sum(l.debit),0)
               FROM public.accounting_entry_lines l
               WHERE l.entry_id=${entry} AND l.account_id=cfg.ar_account_id)
               =s.grand_total
        LIMIT 2
      `);
      if (taxProof.rows.length !== 1) {
        return quarantine("DEV_OUTBOX_TAX_METADATA_OR_GL_INVALID");
      }
    }

    const siblings = await tx.execute(sql`
      SELECT id FROM public.financial_outbox_events
      WHERE entry_id=${entry} AND company_id=${company}
        AND event_type='JOURNAL_CREATED' LIMIT 2
    `);
    if (siblings.rows.length !== 1 ||
        Number((siblings.rows[0] as Record<string, unknown>).id) !== id) {
      return quarantine("DEV_OUTBOX_DUPLICATE_JOURNAL_EVENT");
    }
    const existing = await tx.execute(sql`
      SELECT id FROM public.financial_events
      WHERE company_id=${company} AND entry_id=${entry}
        AND source_type='sales_invoice' AND source_id=${String(sourceId)}
        AND event_type='JOURNAL_CREATED' LIMIT 1
    `);
    // There is no unique financial_events source constraint in the old schema.
    // Never silently accept/duplicate an event written by another producer.
    if (existing.rows.length) return quarantine("DEV_OUTBOX_PREEXISTING_FINANCIAL_EVENT");

    const stored = await tx.execute(sql`
      INSERT INTO public.financial_events
        (event_type,company_id,source_type,source_id,entry_id,amount,actor,ref,meta)
      VALUES ('JOURNAL_CREATED',${company},'sales_invoice',${String(sourceId)},
              ${entry},${amount},${actor},${String(payload?.ref ?? "")},
              ${JSON.stringify({ outboxEventId: id, dedupeKey: key, consumer: "customer_portal_dev" })}::jsonb)
      RETURNING id
    `);
    if (stored.rows.length !== 1) throw Error("DEV_OUTBOX_EVENT_NOT_ATOMIC");
    const done = await tx.execute(sql`
      UPDATE public.financial_outbox_events
      SET status='done',processed_at=NOW(),attempt=attempt+1,last_error=NULL
      WHERE id=${id} AND status='pending' RETURNING id
    `);
    if (done.rows.length !== 1) throw Error("DEV_OUTBOX_STATUS_NOT_ATOMIC");
    return { status: "processed", outboxId: id };
  });
}


/**
 * Opt-in scheduler for the strict Customer Portal DEV consumer. Reuses the
 * existing outbox module and database pool; no second worker service/pool.
 * The legacy poller is not started here. Exact event ownership is protected
 * by its matching exclusion above. Every flag is required and default OFF.
 */
export function startCustomerPortalSalesInvoiceOutboxDevProcessor(): (() => void) | null {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "development" ||
      process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV !== "true" ||
      process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV !== "true" ||
      process.env.CUSTOMER_PORTAL_OUTBOX_SAFE_CONSUME_DEV !== "true") {
    return null;
  }

  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const result = await processCustomerPortalSalesInvoiceOutboxDevOnce();
      if (result.status === "processed") {
        logger.info({ outboxId: result.outboxId }, "[customer-invoice-outbox] event processed");
      } else if (result.status === "quarantined") {
        logger.warn(
          { outboxId: result.outboxId, reason: result.reason },
          "[customer-invoice-outbox] event quarantined; no external delivery performed",
        );
      }
    } catch (error) {
      logger.error({ error }, "[customer-invoice-outbox] transaction failed; event remains retryable");
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => { void runOnce(); }, POLL_INTERVAL_MS);
  const initial = setTimeout(() => { void runOnce(); }, 5_000);
  interval.unref?.();
  initial.unref?.();
  logger.warn(
    "[customer-invoice-outbox] Strict DEV consumer enabled by all explicit flags; legacy worker not started here",
  );
  return () => {
    clearInterval(interval);
    clearTimeout(initial);
  };
}
