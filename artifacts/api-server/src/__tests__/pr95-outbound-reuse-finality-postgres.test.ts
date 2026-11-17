import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  readOutboundReuseFinalityCounts,
  type OutboundReuseQueryClient,
} from "../lib/outboundReuseFinalityReader";

const url = process.env.PR95_ATOMIC_PG_URL;
const suite = url ? describe : describe.skip;
const scope = { companyId: 1, mutationId: 90001, invoiceId: 7, entryId: 314 };

suite("PR95 canonical finality reader against real disposable PostgreSQL 16", () => {
  let client: pg.Client;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== "127.0.0.1" || parsed.port !== "65433"
      || parsed.pathname !== "/pr95_ci"
      || parsed.username !== "postgres.xssrfshdrtdfupgqwfdw") {
      throw Error("REFUSING_NON_DISPOSABLE_PR95_DATABASE");
    }
    client = new pg.Client({ connectionString: url });
    await client.connect();
    // These minimal public tables exist ONLY in ephemeral CI PostgreSQL.
    await client.query(`
      CREATE TABLE public.bank_mutations (
        id integer PRIMARY KEY, company_id integer NOT NULL,
        journal_entry_id integer, status text NOT NULL
      );
      CREATE TABLE public.bank_reconciliation_matches (
        id integer PRIMARY KEY, mutation_id integer NOT NULL, status text NOT NULL
      );
      CREATE TABLE public.payment_matching_groups (
        id integer PRIMARY KEY, status text NOT NULL
      );
      CREATE TABLE public.payment_allocations (
        id integer PRIMARY KEY, company_id integer NOT NULL,
        invoice_id integer NOT NULL, group_id integer, mutation_id integer NOT NULL,
        is_active boolean
      );
      INSERT INTO public.bank_mutations(id,company_id,journal_entry_id,status)
        VALUES(90001,1,NULL,'unmatched'),(90002,2,NULL,'unmatched');
      INSERT INTO public.payment_matching_groups(id,status) VALUES(5,'active');
    `);
  });
  afterAll(async () => {
    if (!client) return;
    await client.query(`
      DROP TABLE IF EXISTS public.payment_allocations;
      DROP TABLE IF EXISTS public.payment_matching_groups;
      DROP TABLE IF EXISTS public.bank_reconciliation_matches;
      DROP TABLE IF EXISTS public.bank_mutations;
    `);
    await client.end();
  });

  const read = () => readOutboundReuseFinalityCounts(
    client as unknown as OutboundReuseQueryClient, scope,
  );

  it("returns zero only when the authentic mutation and source have no finalized custody", async () => {
    await client.query("BEGIN READ ONLY");
    try {
      await expect(read()).resolves.toEqual({
        mutationFinalMatchCount: 0,
        sourceFinalAllocationCount: 0,
        activeApprovedMutationLinkCount: 0,
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("detects final match, final invoice allocation and linked source journal in one transaction, then rolls back", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO public.bank_reconciliation_matches(id,mutation_id,status)
          VALUES(1,90001,'approved');
        INSERT INTO public.payment_allocations(id,company_id,invoice_id,group_id,mutation_id,is_active)
          VALUES(1,1,7,5,90001,true);
        UPDATE public.payment_matching_groups SET status='final' WHERE id=5;
        UPDATE public.bank_mutations SET journal_entry_id=314,status='approved'
          WHERE id=90001;
      `);
      await expect(read()).resolves.toEqual({
        mutationFinalMatchCount: 1,
        sourceFinalAllocationCount: 1,
        activeApprovedMutationLinkCount: 1,
      });
    } finally {
      await client.query("ROLLBACK");
    }
    await expect(read()).resolves.toEqual({
      mutationFinalMatchCount: 0,
      sourceFinalAllocationCount: 0,
      activeApprovedMutationLinkCount: 0,
    });
  });

  it("rejects cross-company invoice allocation and inactive/unfinished group as final custody", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO public.payment_allocations(id,company_id,invoice_id,group_id,mutation_id,is_active)
          VALUES(2,2,7,5,90002,true),(3,1,7,5,90001,false),
                (4,1,7,5,90001,true);
      `);
      await expect(read()).resolves.toMatchObject({ sourceFinalAllocationCount: 0 });
      await client.query("UPDATE public.payment_matching_groups SET status='reconciled' WHERE id=5");
      await expect(read()).resolves.toMatchObject({ sourceFinalAllocationCount: 1 });
    } finally {
      await client.query("ROLLBACK");
    }
    await expect(read()).resolves.toMatchObject({ sourceFinalAllocationCount: 0 });
  });
});
