import type { CashLedgerAdapter, CashLedgerTx, CashJournal, StoredCashJournal } from "./cash-ledger-posting";

/**
 * Disposable QA ONLY. Tables live exclusively in cash_qa schema created by
 * the QA harness. No route, migration, or live Pool instantiates this adapter.
 */
interface PgClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
}
export interface PgClientFactory { connect(): Promise<PgClient> }

export function disposableCashPgAdapter(factory: PgClientFactory): CashLedgerAdapter {
  return {
    async transaction<T>(work: (tx: CashLedgerTx) => Promise<T>): Promise<T> {
      const client = await factory.connect();
      let begun = false;
      try {
        await client.query("BEGIN");
        begun = true;
        const tx: CashLedgerTx = {
          async findForUpdate(sourceKey: string): Promise<StoredCashJournal | null> {
            // Serializes competing inserts before first SELECT. Collision is
            // still protected by unique source_key constraint.
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [sourceKey]);
            const found = await client.query<{ id: string; fingerprint: string }>(
              "SELECT journal_id::text AS id, fingerprint FROM cash_qa.cash_sources WHERE source_key=$1 FOR UPDATE",
              [sourceKey],
            );
            return found.rows[0] ?? null;
          },
          async insertWithLines(journal: CashJournal): Promise<string> {
            const total = (journal.amountCents / 100n).toString() + "." +
              (journal.amountCents % 100n).toString().padStart(2, "0");
            const created = await client.query<{ id: string }>(
              `INSERT INTO cash_qa.accounting_entries (source_key, tx_date, total_debit, total_credit)
               VALUES ($1, $2, $3, $3) RETURNING id::text AS id`,
              [journal.sourceKey, journal.date, total],
            );
            const entryId = created.rows[0]?.id;
            if (!entryId) throw new Error("CASH_JOURNAL_INSERT_FAILED");
            for (const [index, line] of journal.lines.entries()) {
              await client.query(
                `INSERT INTO cash_qa.accounting_entry_lines
                 (entry_id, line_number, account_id, debit, credit)
                 VALUES ($1, $2, $3, $4, $5)`,
                [entryId, index+1, line.accountId,
                  (line.debitCents / 100n).toString() + "." + (line.debitCents % 100n).toString().padStart(2,"0"),
                  (line.creditCents / 100n).toString() + "." + (line.creditCents % 100n).toString().padStart(2,"0")],
              );
            }
            await client.query(
              `INSERT INTO cash_qa.cash_sources (source_key, fingerprint, journal_id)
               VALUES ($1, $2, $3)`,
              [journal.sourceKey, journal.fingerprint, entryId],
            );
            return entryId;
          },
        };
        const answer = await work(tx);
        await client.query("COMMIT");
        begun = false;
        return answer;
      } catch (err) {
        if (begun) {
          try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
        }
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
