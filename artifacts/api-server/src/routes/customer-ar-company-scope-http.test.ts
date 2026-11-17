import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const { access, queries, scopedQueries, financeReadOnly } = vi.hoisted(() => ({
  access: {
    actor: null as null | { id: string; email: string; role: string; companyId: number | null },
    dev: true,
    otpEnabled: false,
    signedSession: false,
    selectedCompany: null as number | null,
    approvedGlobal: true,
    companyActive: true,
  },
  queries: vi.fn(async (_statement: string, _params?: unknown[]) => ({ rows: [] as Array<Record<string, unknown>> })),
  scopedQueries: vi.fn(async (_statement: unknown) => ({ rows: [] })),
  financeReadOnly: vi.fn(),
}));

vi.mock("@workspace/db", () => ({ pool: { query: queries }, withMarketplaceFinanceDevReadOnlyTransaction: financeReadOnly }));
vi.mock("./dev-auth", () => ({
  isDevelopmentEnvironment: () => access.dev,
  isSignedDevAuthEnabled: () => access.otpEnabled,
  getFinanceCompanyScope: () => access.selectedCompany,
  isApprovedFinanceGlobalSuperAdmin: () => access.approvedGlobal,
  isApprovedFinanceGlobalCompany: (id: number) => [1, 3].includes(id),
  getProductionSession: () => access.signedSession
    ? { id: "signed-test", email: "verified@example.invalid", expiresAt: Date.now() + 60_000 }
    : null,
}));
vi.mock("./admin-auth", () => ({
  authenticateAdmin: (req: any, res: any, next: () => void) => {
    if (!access.actor) return res.status(401).json({ error: "Unauthorized" });
    req.adminUser = access.actor;
    next();
  },
}));

import router from "./customer-ar-match-preview";

const companyFlag = "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV";
const originalCompanyFlag = process.env[companyFlag];
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = { error: () => {} };
    next();
  });
  app.use("/api", router);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}/api/sales/customer-invoices/auto-match-preview`;
});

afterAll(async () => {
  if (originalCompanyFlag === undefined) delete process.env[companyFlag];
  else process.env[companyFlag] = originalCompanyFlag;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  access.dev = true;
  access.actor = null;
  access.otpEnabled = false;
  access.signedSession = false;
  queries.mockReset().mockImplementation(async (statement, params) => ({
    rows: statement.includes("public.companies") && access.companyActive ? [{ id: params?.[0] }] : [],
  }));
  access.companyActive = true;
  access.selectedCompany = null;
  access.approvedGlobal = true;
  delete process.env[companyFlag];
  scopedQueries.mockReset().mockResolvedValue({ rows: [] });
  financeReadOnly.mockReset().mockImplementation(async (_companyId, work) => work({ execute: scopedQueries }));
});

async function check(companyId: number) {
  const response = await fetch(`${base}?company_id=${companyId}`);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe("DEV Customer AR HTTP tenant isolation", () => {
  it("denies finance without a verified company binding even in DEV", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "finance", companyId: null };
    const result = await check(2);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("COMPANY_SCOPE_MISSING");
    expect(queries).not.toHaveBeenCalled();
  });

  it("denies an ordinary admin trying another company without reading rows", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "admin", companyId: 1 };
    const result = await check(2);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("COMPANY_SCOPE_MISMATCH");
    expect(queries).not.toHaveBeenCalled();
  });

  it("allows a company-scoped finance reader but creates no settlement", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "finance", companyId: 1 };
    const result = await check(1);
    expect(result.status).toBe(200);
    expect(result.body.mode).toBe("read_only_preview");
    expect(result.body.autoApproveEnabled).toBe(false);
    expect(result.body.autoPostEnabled).toBe(false);
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("allows explicitly privileged owner to select a company", async () => {
    access.actor = { id: "a", email: "test@invalid.example", role: "owner", companyId: null };
    const result = await check(2);
    expect(result.status).toBe(200);
    expect(result.body.companyId).toBe(2);
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("blocks legacy DEV-only cookie for cross-company AR when signed OTP is on", async () => {
    access.otpEnabled = true;
    access.actor = { id: "a", email: "test@invalid.example", role: "super_admin", companyId: 1 };
    const result = await check(2);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("SIGNED_GLOBAL_ADMIN_REQUIRED");
    access.actor = { id: "b", email: "test@invalid.example", role: "owner", companyId: null };
    const global = await check(1);
    expect(global.status).toBe(403);
    expect(global.body.code).toBe("SIGNED_GLOBAL_ADMIN_REQUIRED");
    expect(queries).not.toHaveBeenCalled();
  });

  it("allows verified OTP global reader and same-company legacy reader without posting", async () => {
    access.otpEnabled = true;
    access.actor = { id: "a", email: "test@invalid.example", role: "owner", companyId: null };
    access.signedSession = true;
    const verified = await check(2);
    expect(verified.status).toBe(200);
    expect(verified.body.autoApproveEnabled).toBe(false);
    expect(verified.body.autoPostEnabled).toBe(false);
    expect(queries).toHaveBeenCalledTimes(2);

    queries.mockClear();
    access.signedSession = false;
    access.actor = { id: "b", email: "test@invalid.example", role: "owner", companyId: 1 };
    const scoped = await check(1);
    expect(scoped.status).toBe(200);
    expect(queries).toHaveBeenCalledTimes(2);
  });

  it("rejects anonymous callers and keeps PROD route inaccessible", async () => {
    expect((await check(1)).status).toBe(401);
    access.actor = { id: "a", email: "test@invalid.example", role: "owner", companyId: null };
    access.dev = false;
    expect((await check(1)).status).toBe(404);
    expect(queries).not.toHaveBeenCalled();
  });
});


describe("Customer AR dedicated company read-only routing", () => {
  beforeEach(() => {
    process.env[companyFlag] = "true";
    access.otpEnabled = true;
    access.signedSession = true;
    access.actor = { id: "cst", email: "cst@example.invalid", role: "finance", companyId: 1 };
  });

  it("routes CST reads through one read-only company session with bound parameters", async () => {
    const response = await check(1);
    expect(response.status).toBe(200);
    expect(response.body.autoPostEnabled).toBe(false);
    expect(financeReadOnly).toHaveBeenCalledTimes(1);
    expect(financeReadOnly.mock.calls[0][0]).toBe(1);
    expect(scopedQueries).toHaveBeenCalledTimes(2);
    for (const [statement] of scopedQueries.mock.calls) {
      const query = new PgDialect().sqlToQuery(statement as any);
      expect(query.params).toEqual([1]);
      expect(query.sql).toContain("$1");
    }
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toContain("public.companies");
  });

  it("routes DIVA through its own company identity", async () => {
    access.actor = { id: "diva", email: "diva@example.invalid", role: "finance", companyId: 3 };
    expect((await check(3)).status).toBe(200);
    expect(financeReadOnly.mock.calls[0][0]).toBe(3);
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toContain("public.companies");
  });

  it("denies unsigned same-company cookies and unsupported companies before any DB access", async () => {
    access.signedSession = false;
    expect((await check(1)).body.code).toBe("CUSTOMER_AR_SIGNED_SESSION_REQUIRED");
    access.signedSession = true;
  …31240 tokens truncated…tal, invoice_number,
     invoice_date, due_date, company_id, notes)
    VALUES (reference, 'order', 'confirmed', 'invoiced', 'unpaid', 0,
      'QA rollback only; not a real customer', 100, 0, 100, reference,
      current_date, current_date + 30, 1, 'Synthetic DEV rollback probe only')
    RETURNING id INTO v_invoice_id;
  INSERT INTO public.accounting_entries
    (company_id, entry_number, journal_id, date, ref, description,
     status, source, source_id, total_debit, total_credit, created_by_id)
    VALUES (1, reference, journal, current_date, reference,
      'Synthetic customer AR rollback probe only', 'draft', 'sales_invoice',
      v_invoice_id, 100, 100, 'qa-customer-ar-rollback')
    RETURNING id INTO v_entry_id;
  INSERT INTO public.accounting_entry_lines
    (entry_id, company_id, account_id, debit, credit, description)
    VALUES (v_entry_id, 1, ar_account, 100, 0, 'QA rollback AR'),
      (v_entry_id, 1, revenue_account, 0, 100, 'QA rollback revenue');
  UPDATE public.accounting_entries SET status = 'posted' WHERE id = v_entry_id;
  IF EXISTS (SELECT 1 FROM public.ar_subledger ar WHERE ar.invoice_id = v_invoice_id AND ar.company_id = 1) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_PROJECTION_WAS_NOT_DEFERRED';
  END IF;
  PERFORM set_config('qa.customer_ar_invoice_id', v_invoice_id::text, true);
  PERFORM set_config('qa.customer_ar_entry_id', v_entry_id::text, true);
END
$prepare$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $assert_and_replay$
DECLARE v_invoice_id integer := current_setting('qa.customer_ar_invoice_id')::integer;
  v_entry_id integer := current_setting('qa.customer_ar_entry_id')::integer;
  v_ar_id integer;
BEGIN
  IF (SELECT count(*) FROM public.ar_subledger ar WHERE ar.company_id = 1 AND ar.invoice_id = v_invoice_id) <> 1 THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_EXACTLY_ONE_PROJECTION_REQUIRED';
  END IF;
  SELECT id INTO v_ar_id FROM public.ar_subledger ar
    WHERE ar.company_id = 1 AND ar.invoice_id = v_invoice_id
      AND ar.gl_entry_id = v_entry_id AND ar.gross_amount = 100
      AND ar.outstanding_amount = 100 AND ar.paid_amount = 0 AND ar.status = 'OPEN'
      AND ar.notes = 'bizportal:customer-ar-source:v1';
  IF v_ar_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_AR_QA_SOURCE_PROOF_MISMATCH'; END IF;
  UPDATE public.sales_documents SET updated_at = clock_timestamp() WHERE id = v_invoice_id;
  UPDATE public.sales_documents SET updated_at = clock_timestamp() WHERE id = v_invoice_id;
  IF (SELECT count(*) FROM public.ar_subledger ar WHERE ar.company_id = 1 AND ar.invoice_id = v_invoice_id) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.ar_subledger ar WHERE ar.id = v_ar_id
      AND ar.gl_entry_id = v_entry_id AND ar.paid_amount = 0 AND ar.outstanding_amount = 100) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_REPLAY_CHANGED_BALANCE_OR_IDENTITY';
  END IF;
  -- Project source paid state only; no payment/bank/allocation is created.
  UPDATE public.sales_documents SET amount_paid = 25, payment_status = 'partial' WHERE id = v_invoice_id;
  UPDATE public.sales_documents SET updated_at = clock_timestamp() WHERE id = v_invoice_id;
  UPDATE public.sales_documents SET updated_at = clock_timestamp() WHERE id = v_invoice_id;
  IF NOT EXISTS (SELECT 1 FROM public.ar_subledger ar WHERE ar.id = v_ar_id
      AND ar.gl_entry_id = v_entry_id AND ar.gross_amount = 100
      AND ar.paid_amount = 25 AND ar.outstanding_amount = 75 AND ar.status = 'PARTIAL')
    OR (SELECT count(*) FROM public.ar_subledger ar WHERE ar.company_id = 1 AND ar.invoice_id = v_invoice_id) <> 1 THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_PARTIAL_REPLAY_NOT_ABSOLUTE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_evidence_dev e
    WHERE e.company_id = 1 AND e.invoice_id = v_invoice_id AND e.gl_entry_id = v_entry_id
      AND e.gross_amount = 100 AND e.paid_amount = 25 AND e.outstanding_amount = 75) THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_SHARED_SOURCE_VIEW_DID_NOT_VERIFY';
  END IF;
  IF (SELECT count(*) FROM public.accounting_entries e
    WHERE e.company_id = 1 AND e.source::text = 'sales_invoice' AND e.source_id = v_invoice_id) <> 1
    OR (SELECT count(*) FROM public.accounting_entry_lines l WHERE l.entry_id = v_entry_id) <> 2 THEN
    RAISE EXCEPTION 'CUSTOMER_AR_QA_SOURCE_JOURNAL_CHANGED';
  END IF;
END
$assert_and_replay$;

ROLLBACK;

-- Reaching this SELECT means all above assertions passed and rollback ran.
-- These counts independently verify no QA financial row or activation remains.
SELECT jsonb_build_object(
  'result', 'CUSTOMER_AR_ACTUAL_DEV_PG17_ROLLBACK_PASS',
  'server_version', current_setting('server_version'),
  'issuer', current_user,
  'qa_sales_remaining', (SELECT count(*) FROM public.sales_documents WHERE doc_number LIKE 'QA-CUSTAR-ROLLBACK-%'),
  'qa_entries_remaining', (SELECT count(*) FROM public.accounting_entries WHERE entry_number LIKE 'QA-CUSTAR-ROLLBACK-%'),
  'qa_ar_remaining', (SELECT count(*) FROM public.ar_subledger WHERE invoice_number LIKE 'QA-CUSTAR-ROLLBACK-%'),
  'enabled_actors_after_rollback', (SELECT count(*) FROM public.bizportal_customer_ar_source_actors_dev WHERE enabled),
  'ar_rows_after_rollback', (SELECT count(*) FROM public.ar_subledger)
) AS result;
