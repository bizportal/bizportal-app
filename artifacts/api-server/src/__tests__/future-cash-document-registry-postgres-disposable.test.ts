import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

const url = process.env.CASH_QA_PG_URL;
const suite = url ? describe : describe.skip;
const migration = readFileSync(
  new URL("../../scripts/create-sc-future-cash-evidence-registry-dev.sql", import.meta.url),
  "utf8",
);

/**
 * Runs only against a disposable CASH_QA_PG_URL, never against CST-DEV/PROD.
 * All migration DDL and test rows are confined to a PostgreSQL transaction
 * which is ROLLED BACK in afterAll. No business database is contacted.
 */
suite("Account18 evidence registry DDL — disposable PostgreSQL rollback", () => {
  let client: any;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { Client } = require("pg");
    client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      "SET LOCAL cst.sc_cash_registry_dev = 'CST_DEV_EXPLICIT_20261127'",
    );
    await client.query(migration);
  }, 15000);
  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  }, 15000);

  async function expectRejected(sql: string, params: unknown[] = []) {
    await client.query("SAVEPOINT sc_cash_reject");
    let rejected = false;
    try {
      await client.query(sql, params);
    } catch {
      rejected = true;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT sc_cash_reject");
      await client.query("RELEASE SAVEPOINT sc_cash_reject");
    }
    expect(rejected).toBe(true);
  }

  it("is guarded, enables forced RLS and denies destructive application changes", async () => {
    const tables = await client.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('sc_future_cash_documents','sc_future_cash_document_events') ORDER BY relname",
    );
    expect(tables.rows).toHaveLength(2);
    for (const item of tables.rows) {
      expect(item.relrowsecurity).toBe(true);
      expect(item.relforcerowsecurity).toBe(true);
    }
    // Only in disposable QA transaction, disable RLS so we can exercise the
    // triggers. This never escapes the final ROLLBACK.
    await client.query("ALTER TABLE public.sc_future_cash_documents DISABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE public.sc_future_cash_document_events DISABLE ROW LEVEL SECURITY");
  });

  it("permits pending→verified→revoked once; blocks replay, mutation and changed evidence", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const sha = "a".repeat(64);
    const fp = "b".repeat(64);
    const path = "/objects/uploads/44444444-4444-4444-8444-444444444444.pdf";
    await client.query(
      "INSERT INTO public.sc_future_cash_documents (transaction_id,object_path,document_sha256,source_fingerprint,direction,transaction_date,amount_cents,byte_length,uploaded_by) VALUES ($1,$2,$3,$4,'OUT','2026-11-27',5000000,1024,'owner@example.test')",
      [id, path, sha, fp],
    );
    await expectRejected(
      "UPDATE public.sc_future_cash_documents SET amount_cents=10 WHERE transaction_id=$1",
      [id],
    );
    await expectRejected(
      "INSERT INTO public.sc_future_cash_document_events (transaction_id,event_type,document_sha256,source_fingerprint,actor_email,actor_role) VALUES ($1,'REVOKED',$2,$3,'owner@example.test','owner')",
      [id, sha, fp],
    );
    await expectRejected(
      "INSERT INTO public.sc_future_cash_document_events (transaction_id,event_type,document_sha256,source_fingerprint,actor_email,actor_role) VALUES ($1,'VERIFIED',$2,$3,'owner@example.test','owner')",
      [id, "f".repeat(64), fp],
    );
    await client.query(
      "INSERT INTO public.sc_future_cash_document_events (transaction_id,event_type,document_sha256,source_fingerprint,actor_email,actor_role) VALUES ($1,'VERIFIED',$2,$3,'owner@example.test','owner')",
      [id, sha, fp],
    );
    await expectRejected(
      "DELETE FROM public.sc_future_cash_document_events WHERE transaction_id=$1",
      [id],
    );
    await expectRejected(
      "INSERT INTO public.sc_future_cash_document_events (transaction_id,event_type,document_sha256,source_fingerprint,actor_email,actor_role) VALUES ($1,'VERIFIED',$2,$3,'owner@example.test','owner')",
      [id, sha, fp],
    );
    await client.query(
      "INSERT INTO public.sc_future_cash_document_events (transaction_id,event_type,document_sha256,source_fingerprint,actor_email,actor_role) VALUES ($1,'REVOKED',$2,$3,'owner@example.test','owner')",
      [id, sha, fp],
    );
    const events = await client.query(
      "SELECT event_type FROM public.sc_future_cash_document_events WHERE transaction_id=$1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row: {event_type:string}) => row.event_type))
      .toEqual(["VERIFIED", "REVOKED"]);
    await expectRejected(
      "INSERT INTO public.sc_future_cash_document_events (transaction_id,event_type,document_sha256,source_fingerprint,actor_email,actor_role) VALUES ($1,'VERIFIED',$2,$3,'owner@example.test','owner')",
      [id, sha, fp],
    );
  });
});
