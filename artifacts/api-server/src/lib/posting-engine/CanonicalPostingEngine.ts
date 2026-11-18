/**
 * Canonical Posting Engine (Tahap 3).
 *
 * Single public entry point for creating journal entries. Wraps the existing,
 * battle-tested `_postEntryCore` (via `postEntryWithClient`) — it does NOT
 * reimplement idempotency/period-lock/balance logic, it reuses it inside a
 * transaction this engine controls, so future tax-line inserts can commit or
 * roll back atomically with the journal.
 *
 * See docs/canonical-posting-engine/02-design.md for the full design.
 */

import { db, type accountingEntriesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { postEntryWithClient, type DbClient, type PostingInput } from "../accounting.js";
import { logger } from "../logger.js";
import type { PostingRequest, PostingResult, PostingValidator } from "./types.js";
import { PostingValidationError } from "./types.js";
import { createDefaultValidators } from "./validators.js";

type JournalEntryRow = typeof accountingEntriesTable.$inferSelect;

/**
 * The existing CanonicalPostingEngine remains the ONLY GL writer.
 * Specialized DEV Customer Portal PPN uses its original postEntryWithClient()
 * and writes tax REPORTING metadata inside the same caller-owned transaction.
 * This is not a global v2 tax activation: all other taxes and PROD remain OFF.
 */
function gatedCustomerInvoicePpn(request: PostingRequest, client: DbClient) {
  if (!request.taxes?.length) return null;
  const tax = request.taxes.length === 1 ? request.taxes[0] : null;
  const toCents = (value: unknown): number | null => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number < 100_000_000_000
      ? Math.round(number * 100) : null;
  };
  const base = toCents(tax?.baseAmount);
  const ppn = toCents(tax?.taxAmount);
  const rate = Number(tax?.rate);
  const ppnAccountId = Number(tax?.glAccountId);
  const ar = request.lines[0], rev = request.lines[1], output = request.lines[2];
  const ok =
    process.env.APP_ENV?.trim().toLowerCase() === "development" &&
    process.env.CUSTOMER_PORTAL_ATOMIC_ACCOUNTING_POST_DEV === "true" &&
    process.env.CUSTOMER_PORTAL_REQUIRE_POSTED_AR_EVIDENCE_DEV === "true" &&
    process.env.CUSTOMER_PORTAL_TAX_ATOMIC_POST_DEV === "true" &&
    client !== db && tax?.taxType === "PPN_OUT" &&
    request.source === "sales_invoice" && [1,3].includes(request.companyId) &&
    Number.isSafeInteger(request.sourceId) && request.sourceId > 0 &&
    request.initialStatus !== "draft" &&
    typeof request.createdById === "string" && request.createdById.length > 0 &&
    request.lines.length === 3 &&
    base !== null && base > 0 && ppn !== null && ppn > 0 &&
    Number.isFinite(rate) && (rate === 11 || rate === 12) &&
    Math.round(base * rate / 100) === ppn &&
    Number.isSafeInteger(ppnAccountId) && ppnAccountId > 0 &&
    Number.isSafeInteger(Number(ar?.accountId)) &&
    Number.isSafeInteger(Number(rev?.accountId)) &&
    Number(ar?.accountId) !== Number(rev?.accountId) &&
    Number(output?.accountId) === ppnAccountId &&
    Number(ar?.accountId) !== ppnAccountId &&
    Number(rev?.accountId) !== ppnAccountId &&
    toCents(ar?.debit) === base + ppn &&
    toCents(ar?.credit ?? 0) === 0 &&
    toCents(rev?.credit) === base &&
    toCents(rev?.debit ?? 0) === 0 &&
    toCents(output?.credit) === ppn &&
    toCents(output?.debit ?? 0) === 0;
  return ok ? { base: base! / 100, amount: ppn! / 100, rate, accountId: ppnAccountId }
    : false;
}

export class CanonicalPostingEngine {
  constructor(private readonly validators: PostingValidator[] = createDefaultValidators()) {}

  /**
   * Post using the caller's transaction client when one is supplied.
   *
   * The default remains the root db client for existing callers. Payment
   * ingestion supplies its transaction client so validators, the journal, its
   * lines, and the source/payment links all share one PostgreSQL transaction.
   */
  async post(request: PostingRequest, client: DbClient = db): Promise<PostingResult> {
    const devPpn = gatedCustomerInvoicePpn(request, client);
    if (devPpn === false) {
      // Explicit fail-closed policy for ALL other tax sources and every PROD
      // caller; do not change the original untaxed posting path.
      return {
        ok: false,
        error: "Atomic tax posting belum diizinkan untuk sumber/PPN ini.",
        errorCode: "TRANSACTION_FAILED",
      };
    }

    try {
      for (const validator of this.validators) {
        await validator.validate(request, { client });
      }
    } catch (err) {
      if (err instanceof PostingValidationError) {
        logger.warn({ err, source: request.source, sourceId: request.sourceId }, `[posting-engine] validation failed: ${err.code}`);
        return { ok: false, error: err.message, errorCode: err.code };
      }
      throw err;
    }

    const input: PostingInput = {
      journalId: request.journalId,
      date: request.date,
      ref: request.ref ?? null,
      description: request.description ?? null,
      paymentMethod: request.paymentMethod ?? null,
      source: request.source,
      sourceId: request.sourceId,
      companyId: request.companyId,
      createdById: request.createdById ?? null,
      lines: request.lines,
    };

    try {
      // The caller owns the transaction boundary. postEntryWithClient inserts
      // the entry as draft, inserts lines, then promotes it to posted.
      const entry: JournalEntryRow = await postEntryWithClient(client, input, request.journalCode, request.initialStatus ?? "posted");

      if (devPpn) {
        // Only tax REPORTING metadata is inserted here; the original posting
        // engine above created the ONE balanced 3-line GL. The caller still
        // owns BEGIN/COMMIT/ROLLBACK and deferred source/AR triggers.
        // The locked original Invoice source serializes same-Invoice retries.
        const prior = await client.execute(sql`
          select id from public.gl_tax_lines
          where company_id = ${request.companyId}
            and accounting_entry_id = ${entry.id}
            and tax_type = 'PPN_OUT' and direction = 'out'
          limit 2 for update
        `);
        if (prior.rows.length) throw Error("DEV_SALES_PPN_DUPLICATE_TAX_METADATA");
        const period = request.date.toISOString().slice(0, 7);
        const inserted = await client.execute(sql`
          insert into public.gl_tax_lines
            (company_id,accounting_entry_id,tax_type,rate,base_amount,
             tax_amount,direction,period,entity_type,entity_id)
          values (${request.companyId},${entry.id},'PPN_OUT',${devPpn.rate},
                  ${devPpn.base},${devPpn.amount},'out',${period},
                  'sales_invoice',${String(request.sourceId)})
          returning id
        `);
        if (inserted.rows.length !== 1)
          throw Error("DEV_SALES_PPN_TAX_METADATA_NOT_PERSISTED");
      }

      // These hooks are only safe for the root-client path. A transaction
      // caller may still roll back after post() returns, so it must publish
      // its own post-commit effects after the transaction commits.
      if (client === db) {
        import("../ledgerImmutability.js").then(({ lockAccountingEntry }) => {
          lockAccountingEntry(entry.id, request.createdById ?? "SYSTEM").catch(() => {});
        }).catch(() => {});
        import("../events/financialEventBus.js").then(({ emitJournalCreated }) => {
          emitJournalCreated({
            entryId: entry.id,
            sourceType: request.source,
            sourceId: request.sourceId,
            amount: request.lines.reduce((s, l) => s + (l.debit ?? 0), 0),
            actor: request.createdById ?? "SYSTEM",
            ref: request.ref ?? null,
            companyId: request.companyId,
          });
        }).catch(() => {});
      }

      return { ok: true, entryId: entry.id };
    } catch (err) {
      const e = err as Error;
      logger.error({ err: e, source: request.source, sourceId: request.sourceId }, "[posting-engine] transaction failed");
      return { ok: false, error: e.message, errorCode: "TRANSACTION_FAILED" };
    }
  }
}
