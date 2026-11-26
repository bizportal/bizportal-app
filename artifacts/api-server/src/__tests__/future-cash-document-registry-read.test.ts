import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareFutureCashSource, type FutureCashSource }
  from "../lib/future-cash-source-identity";
import { readVerifiedFutureCashDocument }
  from "../lib/future-cash-document-registry-read";

const source: FutureCashSource = {
  companyId: 1, accountId: 18, cashCoaId: 75839,
  transactionId: "33333333-3333-4333-8333-333333333333",
  sourceDocumentSha256: "a".repeat(64),
  direction: "OUT", amount: "50000.00", date: "2026-11-27",
};
const row = {
  transaction_id: source.transactionId, company_id: 1, account_id: 18,
  cash_coa_id: 75839, object_bucket: "private-uploads",
  object_path: "/objects/uploads/44444444-4444-4444-8444-444444444444.pdf",
  document_sha256: source.sourceDocumentSha256,
  source_fingerprint: prepareFutureCashSource(source).sourceFingerprint,
  direction: "OUT", transaction_date: "2026-11-27",
  amount_cents: "5000000", event_type: "VERIFIED" as string | null,
  event_at: "2026-11-27 00:04:00+00" as string | null,
  actor_email: "owner@example.test" as string | null,
};
const db = (rows = [row]) => ({
  query: vi.fn(async (_sql: string, _params: readonly unknown[]) => ({ rows })),
});

describe("Account18 server-owned document registry (SELECT only, no writer)", () => {
  it("reads the latest verified event and only returns scoped evidence", async () => {
    const reader = db();
    expect(await readVerifiedFutureCashDocument(source, reader)).toEqual({
      transactionId: source.transactionId, companyId: 1, accountId: 18,
      objectPath: row.object_path,
      verifiedSha256: source.sourceDocumentSha256, status: "VERIFIED",
      verifiedBy: "owner@example.test", verifiedAt: "2026-11-27T00:04:00.000Z",
    });
    expect(reader.query.mock.calls[0]![1]).toEqual([source.transactionId, 1, 18]);
    const sql = reader.query.mock.calls[0]![0].toLowerCase();
    expect(sql.trim().startsWith("select")).toBe(true);
    expect(sql).not.toMatch(/\b(insert|update|delete|create|drop|alter)\b/);
    expect(sql).toContain("order by event_id desc limit 1");
  });

  it("never promotes pending or revoked documents", async () => {
    for (const changed of [
      { ...row, event_type: null },
      { ...row, event_type: "REVOKED" },
      { ...row, event_type: "PENDING" },
      { ...row, event_at: null },
    ]) {
      expect(await readVerifiedFutureCashDocument(source, db([changed]))).toBeNull();
    }
  });

  it("rejects cross-company, wrong cash COA and changed transaction facts", async () => {
    for (const changed of [
      { ...row, company_id: 2 },
      { ...row, account_id: 1 },
      { ...row, cash_coa_id: 49097 },
      { ...row, transaction_id: "55555555-5555-4555-8555-555555555555" },
      { ...row, source_fingerprint: "f".repeat(64) },
      { ...row, document_sha256: "0".repeat(64) },
      { ...row, object_bucket: "public-assets" },
      { ...row, direction: "IN" },
      { ...row, transaction_date: "2026-11-26" },
      { ...row, amount_cents: "5000001" },
      { ...row, event_at: "invalid timestamp" },
    ]) {
      expect(await readVerifiedFutureCashDocument(source, db([changed]))).toBeNull();
    }
    expect(await readVerifiedFutureCashDocument({ ...source, amount: "50000.01" },
      db())).toBeNull();
    expect(await readVerifiedFutureCashDocument({ ...source, accountId: 1 },
      db())).toBeNull();
  });

  it("fails closed for missing, ambiguous and unavailable repository", async () => {
    expect(await readVerifiedFutureCashDocument(source, db([]))).toBeNull();
    expect(await readVerifiedFutureCashDocument(source, db([row, row]))).toBeNull();
    const failed = { query: vi.fn(async () => { throw Error("SQL PASSWORD SECRET"); }) };
    expect(await readVerifiedFutureCashDocument(source, failed)).toBeNull();
  });

  it("defines a guarded append-only schema with no browser policies or journal writer", () => {
    const script = readFileSync(
      new URL("../../scripts/create-sc-future-cash-evidence-registry-dev.sql", import.meta.url),
      "utf8",
    ).toLowerCase();
    expect(script).toContain("cst_dev_explicit_20261127");
    expect(script).toContain("create table if not exists public.sc_future_cash_documents");
    expect(script).toContain("create table if not exists public.sc_future_cash_document_events");
    expect(script).toContain("sc_future_cash_reject_mutation");
    expect(script).toContain("sc_future_cash_validate_evidence_event");
    expect(script).toContain("force row level security");
    expect(script.match(/set search_path = pg_catalog/g)).toHaveLength(2);
    expect(script).toContain("revoke execute on function public.sc_future_cash_reject_mutation() from public");
    expect(script).toContain("revoke execute on function public.sc_future_cash_validate_evidence_event() from public");
    expect(script).toContain("revoke all");
    expect(script).not.toContain("public.accounting_entries");
    expect(script).not.toContain("public.bank_mutations");
    expect(script).not.toContain("public.bank_sheet_configs");
  });
});
