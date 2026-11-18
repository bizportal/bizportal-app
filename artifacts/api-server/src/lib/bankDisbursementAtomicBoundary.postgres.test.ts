import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  commitVendorInvoicePaymentAtomic,
  type AtomicSettlementAdapter,
  type CommittedSettlement,
  type InvoiceSettlementInput,
  type LockedInvoice,
} from "./bankDisbursementAtomicBoundary";
import type { PoolClient } from "pg";
import express from "express";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const enabled = Boolean(process.env.PR95_ATOMIC_PG_URL);
const base: InvoiceSettlementInput = {
  companyId: 1, invoiceId: 77, idempotencyKey: "pr95-postgres-key-001",
  grossMinor: 6000, withholdingMinor: 600,
};

describe.skipIf(!enabled)("PR95 boundary with real disposable PostgreSQL transactions", () => {
  let pool: typeof import("@workspace/db")["pool"];
  let server: Server;
  let httpBase: string;
  let failAfter: "journal" | "disbursement" | null = null;
  let corruptJournal = false;
  let corruptHeader = false;

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
      verifyCommittedReceipt: async (tx, receipt) => {
        // Disposable facsimile of canonical custody: journal posted, linked
        // disbursement posted, and one active/final allocation for the invoice.
        const result=await tx.query(`
          SELECT j.id
            FROM pr95_real.journals j
            JOIN pr95_real.disbursements d ON d.journal_id=j.id
            JOIN pr95_real.allocations a ON a.disbursement_id=d.id
           WHERE j.id=$1 AND d.id=$2
             AND j.company_id=$3 AND d.company_id=$3 AND a.company_id=$3
             AND j.invoice_id=$4 AND d.invoice_id=$4 AND a.invoice_id=$4
             AND j.status='posted' AND d.status='posted'
             AND a.is_active=true AND a.status='final'
             AND a.gross_minor=$5
           LIMIT 1`,
          [receipt.journalId,receipt.disbursementId,receipt.companyId,
           receipt.invoiceId,receipt.grossMinor],
        );
        return result.rowCount===1;
      },
      postJournal: async (tx, input) => {
        const r = await tx.query(
          `INSERT INTO pr95_real.journals(company_id,invoice_id,idempotency_key,gross_minor,withholding_minor,header_debit,header_credit,status)
           VALUES($1,$2,$3,$4,$5,$4,$4,'posted') RETURNING id`,
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
        if (corruptHeader) {
          await tx.query(
            "UPDATE pr95_real.journals SET header_credit=header_credit+1 WHERE id=$1",
            [id],
          );
        }
        if (failAfter === "journal") throw Error("FAIL_AFTER_JOURNAL");
        return id;
      },
      createDisbursement: async (tx, input, journalId) => {
        const r=await tx.query(
          `INSERT INTO pr95_real.disbursements(company_id,invoice_id,journal_id,status)
           VALUES($1,$2,$3,'posted') RETURNING id`,
          [input.companyId,input.invoiceId,journalId],
        );
        if (failAfter === "disbursement") throw Error("FAIL_AFTER_DISBURSEMENT");
        await tx.query(`
          INSERT INTO pr95_real.allocations(company_id,invoice_id,disbursement_id,gross_minor,status,is_active)
          VALUES($1,$2,$3,$4,'final',true)`,
          [input.companyId,input.invoiceId,r.rows[0].id,input.grossMinor],
        );
        return r.rows[0].id as number;
      },
      isJournalBalanced: async (tx, companyId, journalId) => {
        const result = await tx.query(
          `SELECT COUNT(*)::int AS line_count,
                  COALESCE(SUM(l.debit),0)::int AS debit_total,
                  COALESCE(SUM(l.credit),0)::int AS credit_total,
                  j.header_debit,j.header_credit,j.status
             FROM pr95_real.journals j
             JOIN pr95_real.lines l ON l.journal_id=j.id
            WHERE j.id=$1 AND j.company_id=$2
            GROUP BY j.id,j.header_debit,j.header_credit,j.status`,
          [journalId, companyId],
        );
        const row=result.rows[0];
        return Boolean(row && row.status==="posted" && row.line_count>=2 &&
          row.debit_total>0 && row.debit_total===row.credit_total &&
          row.header_debit===row.debit_total &&
          row.header_credit===row.credit_total);
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
        header_debit integer NOT NULL,header_credit integer NOT NULL,status text NOT NULL,
        UNIQUE(company_id,idempotency_key));
      CREATE TABLE pr95_real.lines(
        journal_id integer NOT NULL REFERENCES pr95_real.journals(id),account text NOT NULL,
        debit integer NOT NULL,credit integer NOT NULL);
      CREATE TABLE pr95_real.disbursements(
        id serial PRIMARY KEY,company_id integer NOT NULL,invoice_id integer NOT NULL,
        journal_id integer NOT NULL UNIQUE REFERENCES pr95_real.journals(id),
        status text NOT NULL);
      CREATE TABLE pr95_real.allocations(
        id serial PRIMARY KEY,company_id integer NOT NULL,invoice_id integer NOT NULL,
        disbursement_id integer NOT NULL REFERENCES pr95_real.disbursements(id),
        gross_minor integer NOT NULL,status text NOT NULL,is_active boolean NOT NULL);`);

    // Test-only HTTP harness. Never imported by any production router.
    // This verifies the SAME candidate boundary + real PG adapter over HTTP,
    // not the archived sole-executor, real auth, or payment posting service.
    const app=express();
    app.use(express.json({ limit: "8kb" }));
    app.post("/__test_only__/atomic-vendor-payment", async (req,res) => {
      if (req.get("x-pr95-test-token") !== "disposable-only") {
        res.status(403).json({ error:"FORBIDDEN" }); return;
      }
      const body=req.body as Record<string, unknown>;
      if (body && Object.keys(body).some(k =>
        !["companyId","invoiceId","idempotencyKey","grossMinor","withholdingMinor"].includes(k))) {
        res.status(422).json({ error:"UNSUPPORTED_FIELD" }); return;
      }
      try {
        const result=await commitVendorInvoicePaymentAtomic(body as InvoiceSettlementInput,adapter());
        res.status(result.outcome==="created"?201:result.outcome==="replayed"?200:
          result.outcome==="rejected" && result.reason==="idempotency_conflict"?409:422).json(result);
      } catch {
        res.status(503).json({ error:"TRANSACTION_ROLLED_BACK" });
      }
    });
    server=createServer(app);
    server.listen(0,"127.0.0.1");
    await once(server,"listening");
    const address=server.address();
    if (!address || typeof address==="string") throw Error("No isolated HTTP port");
    httpBase="http://127.0.0.1:"+address.port;
  });
  beforeEach(async () => {
    failAfter=null;
    corruptJournal=false;
    corruptHeader=false;
    await pool.query("TRUNCATE pr95_real.allocations,pr95_real.disbursements,pr95_real.lines,pr95_real.journals,pr95_real.invoices RESTART IDENTITY");
    await pool.query("INSERT INTO pr95_real.invoices(id,company_id,outstanding_minor,status) VALUES(77,1,10000,'posted'),(78,1,10000,'posted'),(88,2,10000,'posted')");
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve,reject)=>
      server.close(error=>error?reject(error):resolve()));
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

  it("rolls back when Accounting header totals diverge from otherwise balanced lines", async () => {
    corruptHeader=true;
    await expect(commitVendorInvoicePaymentAtomic(base,adapter()))
      .rejects.toThrow("ATOMIC_SETTLEMENT_UNBALANCED_JOURNAL");
    expect(await counters()).toMatchObject({
      journal_count:0,disbursement_count:0,outstanding:10000,unbalanced:0,
    });
  });

  it("refuses replay after its canonical allocation was deactivated", async () => {
    expect((await commitVendorInvoicePaymentAtomic(base,adapter())).outcome).toBe("created");
    await pool.query("UPDATE pr95_real.allocations SET is_active=false");
    await expect(commitVendorInvoicePaymentAtomic(base,adapter()))
      .rejects.toThrow("ATOMIC_SETTLEMENT_UNVERIFIED_REPLAY");
    expect(await counters()).toMatchObject({
      journal_count:1,disbursement_count:1,outstanding:4000,unbalanced:0,
    });
  });

  it("refuses replay after linked disbursement is voided", async () => {
    expect((await commitVendorInvoicePaymentAtomic(base,adapter())).outcome).toBe("created");
    await pool.query("UPDATE pr95_real.disbursements SET status='void'");
    await expect(commitVendorInvoicePaymentAtomic(base,adapter()))
      .rejects.toThrow("ATOMIC_SETTLEMENT_UNVERIFIED_REPLAY");
  });

  it("refuses replay after journal status is voided", async () => {
    expect((await commitVendorInvoicePaymentAtomic(base,adapter())).outcome).toBe("created");
    await pool.query("UPDATE pr95_real.journals SET status='void'");
    await expect(commitVendorInvoicePaymentAtomic(base,adapter()))
      .rejects.toThrow("ATOMIC_SETTLEMENT_UNVERIFIED_REPLAY");
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

  async function httpPayment(body: InvoiceSettlementInput, token="disposable-only") {
    const response=await fetch(httpBase+"/__test_only__/atomic-vendor-payment",{
      method:"POST",headers:{"Content-Type":"application/json","x-pr95-test-token":token},
      body:JSON.stringify(body),
    });
    return { status:response.status, body:await response.json() as Record<string,unknown> };
  }

  it("exercises the candidate through actual HTTP and real PG with exact replay", async () => {
    expect((await httpPayment(base,"wrong-token")).status).toBe(403);
    expect((await httpPayment(base)).status).toBe(201);
    const replay=await httpPayment(base);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({outcome:"replayed"});
    const conflict=await httpPayment({...base,grossMinor:6100});
    expect(conflict.status).toBe(409);
    expect(await counters()).toMatchObject({
      journal_count:1,disbursement_count:1,outstanding:4000,unbalanced:0,
    });
  });

  it("rejects simultaneous HTTP attempts with the same key across different invoices", async () => {
    const results=await Promise.all([
      httpPayment({...base,idempotencyKey:"pr95-http-cross-invoice"}),
      httpPayment({...base,invoiceId:78,idempotencyKey:"pr95-http-cross-invoice"}),
    ]);
    expect(results.map(x=>x.status).sort()).toEqual([201,409]);
    expect(await counters()).toMatchObject({
      journal_count:1,disbursement_count:1,unbalanced:0,
    });
  });

  it("rolls back journal and disbursement on simulated HTTP transaction failure", async () => {
    failAfter="disbursement";
    const result=await httpPayment(base);
    expect(result).toMatchObject({status:503,body:{error:"TRANSACTION_ROLLED_BACK"}});
    expect(await counters()).toMatchObject({
      journal_count:0,disbursement_count:0,outstanding:10000,unbalanced:0,
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
