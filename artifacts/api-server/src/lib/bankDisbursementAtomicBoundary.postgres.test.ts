import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  commitVendorInvoicePaymentAtomic,
  type AtomicSettlementAdapter,
  type CommittedSettlement,
  type InvoiceSettlementInput,
  type LockedInvoice,
} from "./bankDisbursementAtomicBoundary";
import type { PoolClient } from "pg";

const enabled = Boolean(process.env.PR95_ATOMIC_PG_URL);
const base: InvoiceSettlementInput = {
  companyId: 1, invoiceId: 77, idempotencyKey: "pr95-postgres-key-001",
  grossMinor: 6000, withholdingMinor: 600,
};

describe.skipIf(!enabled)("PR95 boundary with real disposable PostgreSQL transactions", () => {
  let pool: typeof import("@workspace/db")["pool"];
  let failAfter: "journal" | "disbursement" | null = null;
  let corruptJournal = false;

  function adapter(): AtomicSettlementAdapter<PoolClient> {
    return {
      lockRequestKey: async (tx, companyId, key) => {
        // Unique transaction-scoped lock for this company/key independent of invoice.
        // A 64-bit hash collision merely serializes unrelated operations.
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [companyId + ":" + key],
        );
      },
      transaction: async fn => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      lockInvoice: async (tx, companyId, invoiceId): Promise<LockedInvoice | null> => {
        const result = await tx.query(
          "SELECT company_id,id,outstanding_minor,status FROM pr95_real.invoices WHERE company_id=$1 AND id=$2 FOR UPDATE",
          [companyId, invoiceId],
        );
        const row = result.rows[0];
        return row ? {
          companyId: row.company_id, invoiceId: row.id,
          outstandingMinor: row.outstanding_minor, status: row.status,
        } : null;
      },
      findByKey: async (tx, companyId, key) => {
        const r = await tx.query(
          `SELECT j.company_id,j.invoice_id,j.idempotency_key,j.gross_minor,j.withholding_minor,
                  j.id AS journal_id,d.id AS disbursement_id
             FROM pr95_real.journals j
             JOIN pr95_real.disbursements d ON d.journal_id=j.id
            WHERE j.company_id=$1 AND j.idempotency_key=$2`,
          [companyId, key],
        );
        const row = r.rows[0];
        return row ? {
          companyId: row.company_id, invoiceId: row.invoice_id,
          idempotencyKey: row.idempotency_key,
          grossMinor: row.gross_minor, withholdingMinor: row.withholding_minor,
          journalId: row.journal_id, disbursementId: row.disbursement_id,
        } satisfies CommittedSettlement : null;
      },
      postJournal: async (tx, input) => {
        const r = await tx.query(
          `INSERT INTO pr95_real.journals(company_id,invoice_id,idempotency_key,gross_minor,withholding_minor)
           VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [input.companyId,input.invoiceId,input.idempotencyKey,input.grossMinor,input.withholdingMinor],
        );
        const id = r.rows[0].id as number;
        await tx.query(`INSERT INTO pr95_real.lines(journal_id,account,debit,credit) VALUES
          ($1,'AP',$2,0),($1,'WHT',0,$3),($1,'BANK',0,$4)`,
          [id,input.grossMinor,input.withholdingMinor,input.grossMinor-input.withholdingMinor],
        );
        if (corruptJournal) {
          await tx.query(
            "UPDATE pr95_real.lines SET credit=credit+1 WHERE journal_id=$1 AND account='BANK'",
            [id],
          );
        }
        if (failAfter === "journal") throw Error("FAIL_AFTER_JOURNAL");
        return id;
      },
      createDisbursement: async (tx, input, journalId) => {
        const r=await tx.query(
          `INSERT INTO pr95_real.disbursements(company_id,invoice_id,journal_id)
           VALUES($1,$2,$3) RETURNING id`,
          [input.companyId,input.invoiceId,journalId],
        );
        if (failAfter === "disbursement") throw Error("FAIL_AFTER_DISBURSEMENT");
        return r.rows[0].id as number;
      },
      isJournalBalanced: async (tx, companyId, journalId) => {
        const result = await tx.query(
          `SELECT COUNT(*)::int AS line_count,
                  COALESCE(SUM(l.debit),0)::int AS debit_total,
                  COALESCE(SUM(l.credit),0)::int AS credit_total
             FROM pr95_real.journals j
             JOIN pr95_real.lines l ON l.journal_id=j.id
            WHERE j.id=$1 AND j.company_id=$2
            GROUP BY j.id`,
          [journalId, companyId],
        );
        const row=result.rows[0];
        return Boolean(row && row.line_count>=2 &&
          row.debit_total>0 && row.debit_total===row.credit_total);
      },
      updateInvoiceBalance: async (tx, input) => {
        const r = await tx.query(
          `UPDATE pr95_real.invoices SET outstanding_minor=outstanding_minor-$3,
             status=CASE WHEN outstanding_minor=$3 THEN 'paid' ELSE status END
           WHERE company_id=$1 AND id=$2 AND status='posted'
             AND outstanding_minor >= $3 RETURNING id`,
          [input.companyId,input.invoiceId,input.grossMinor],
        );
        return r.rowCount===1;
      },
    };
  }

  beforeAll(async () => {
    const url=new URL(process.env.PR95_ATOMIC_PG_URL!);
    if (url.hostname!=="127.0.0.1" || url.port!=="65433" ||
        url.pathname!=="/pr95_ci" || url.username!=="postgres.xssrfshdrtdfupgqwfdw") {
      throw Error("Refusing non-disposable PR95 database");
    }
    process.env.APP_ENV="development";
    process.env.SUPABASE_DATABASE_URL_DEV=process.env.PR95_ATOMIC_PG_URL;
    ({pool}=await import("@workspace/db"));
    await pool.query(`CREATE SCHEMA pr95_real;
      CREATE TABLE pr95_real.invoices(
        id integer PRIMARY KEY,company_id integer NOT NULL,outstanding_minor integer NOT NULL,status text NOT NULL);
      CREATE TABLE pr95_real.journals(
        id serial PRIMARY KEY,company_id integer NOT NULL,invoice_id integer NOT NULL,
        idempotency_key text NOT NULL,gross_minor integer NOT NULL,withholding_minor integer NOT NULL,
        UNIQUE(company_id,idempotency_key));
      CREATE TABLE pr95_real.lines(
        journal_id integer NOT NULL REFERENCES pr95_real.journals(id),account text NOT NULL,
        debit integer NOT NULL,credit integer NOT NULL);
      CREATE TABLE pr95_real.disbursements(
        id serial PRIMARY KEY,company_id integer NOT NULL,invoice_id integer NOT NULL,
        journal_id integer NOT NULL UNIQUE REFERENCES pr95_real.journals(id));`);
  });
  beforeEach(async () => {
    failAfter=null;
    corruptJournal=false;
    await pool.query("TRUNCATE pr95_real.disbursements,pr95_real.lines,pr95_real.journals,pr95_real.invoices RESTART IDENTITY");
    await pool.query("INSERT INTO pr95_real.invoices(id,company_id,outstanding_minor,status) VALUES(77,1,10000,'posted'),(78,1,10000,'posted'),(88,2,10000,'posted')");
  });
  afterAll(async () => {
    if (pool) {
      await pool.query("DROP SCHEMA IF EXISTS pr95_real CASCADE");
      await pool.end();
    }
  });

  async function counters() {
    const r=await pool.query(`SELECT
      (SELECT count(*)::int FROM pr95_real.journals) journal_count,
      (SELECT count(*)::int FROM pr95_real.disbursements) disbursement_count,
      (SELECT outstanding_minor FROM pr95_real.invoices WHERE id=77) outstanding,
      (SELECT count(*)::int FROM
        (SELECT journal_id FROM pr95_real.lines GROUP BY journal_id
         HAVING sum(debit)<>sum(credit)) mismatch) unbalanced`);
    return r.rows[0];
  }

  it("persists balanced journal, WHT, exact replay, and conflict on altered payload", async () => {
    expect((await commitVendorInvoicePaymentAtomic(base,adapter())).outcome).toBe("created");
    expect((await commitVendorInvoicePaymentAtomic(base,adapter())).outcome).toBe("replayed");
    expect(await commitVendorInvoicePaymentAtomic({...base,grossMinor:6100},adapter())).toEqual({
      outcome:"rejected",reason:"idempotency_conflict",
    });
    expect(await counters()).toMatchObject({
      journal_count:1,disbursement_count:1,outstanding:4000,unbalanced:0,
    });
  });
  it("fails closed across tenant company before any journal", async () => {
    expect(await commitVendorInvoicePaymentAtomic({...base,companyId:2},adapter())).toEqual({
      outcome:"rejected",reason:"unavailable",
    });
    expect(await counters()).toMatchObject({journal_count:0,disbursement_count:0});
  });
  it.each(["journal","disbursement"] as const)("rolls back real DB after %s injection", async stage => {
    failAfter=stage;
    await expect(commitVendorInvoicePaymentAtomic(base,adapter())).rejects.toThrow();
    expect(await counters()).toMatchObject({
      journal_count:0,disbursement_count:0,outstanding:10000,
    });
  });
  it("rolls back real PostgreSQL journal and disbursement when ledger lines are unbalanced", async () => {
    corruptJournal=true;
    await expect(commitVendorInvoicePaymentAtomic(base,adapter()))
      .rejects.toThrow("ATOMIC_SETTLEMENT_UNBALANCED_JOURNAL");
    expect(await counters()).toMatchObject({
      journal_count:0,disbursement_count:0,outstanding:10000,unbalanced:0,
    });
  });

  it("serializes simultaneous same-key requests in real Postgres", async () => {
    const results=await Promise.all([
      commitVendorInvoicePaymentAtomic(base,adapter()),
      commitVendorInvoicePaymentAtomic(base,adapter()),
    ]);
    expect(results.map(x=>x.outcome).sort()).toEqual(["created","replayed"]);
    expect(await counters()).toMatchObject({
      journal_count:1,disbursement_count:1,outstanding:4000,unbalanced:0,
    });
  });
  it("serializes the same key across two DIFFERENT company-1 invoices", async () => {
    const results = await Promise.all([
      commitVendorInvoicePaymentAtomic({...base,idempotencyKey:"pr95-cross-invoice-key"},adapter()),
      commitVendorInvoicePaymentAtomic({
        ...base,invoiceId:78,idempotencyKey:"pr95-cross-invoice-key",
      },adapter()),
    ]);
    expect(results.map(x=>x.outcome).sort()).toEqual(["created","rejected"]);
    expect(results.find(x=>x.outcome==="rejected")).toMatchObject({
      outcome:"rejected",reason:"idempotency_conflict",
    });
    expect(await counters()).toMatchObject({
      journal_count:1,disbursement_count:1,unbalanced:0,
    });
  });

  it("rejects simultaneous distinct keys that would overpay", async () => {
    const results=await Promise.all([
      commitVendorInvoicePaymentAtomic({...base,grossMinor:8000,idempotencyKey:"pr95-key-unique-1"},adapter()),
      commitVendorInvoicePaymentAtomic({...base,grossMinor:8000,idempotencyKey:"pr95-key-unique-2"},adapter()),
    ]);
    expect(results.map(x=>x.outcome).sort()).toEqual(["created","rejected"]);
    expect(await counters()).toMatchObject({
      journal_count:1,disbursement_count:1,outstanding:2000,unbalanced:0,
    });
  });
});
