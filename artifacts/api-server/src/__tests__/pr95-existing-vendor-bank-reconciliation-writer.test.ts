import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source contract for the EXISTING canonical bank-mutation vendor invoice batch
// writer. This is NOT a Bank Disbursement POST test and never calls a database.
const source=readFileSync(resolve(process.cwd(),"src/routes/bank-reconciliation.ts"),"utf8");
const start=source.indexOf('router.post("/bank-reconciliation/:mutationId/vendor-invoice-payment-batch"');
const end=source.indexOf("\n});",start);
const route=source.slice(start,end+4);

describe("preserve canonical bank-mutation Vendor Invoice batch writer during PR95 migration",()=>{
  it("reuses the registered bank-reconciliation writer instead of inventing a second allocation writer",()=>{
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(route).toContain("getApprovalActor(req)");
    expect(route).toContain("vendor_invoice_ids");
    expect(route).toContain("mutationId");
  });

  it("keeps a single database transaction around journal, bank mutation, matching group and allocation",()=>{
    const begin=route.indexOf('await client.query("begin")');
    const journal=route.indexOf("insert into public.accounting_entries");
    const lines=route.indexOf("insert into public.accounting_entry_lines");
    const group=route.indexOf("insert into public.payment_matching_groups");
    const allocation=route.indexOf("insert into public.payment_allocations");
    const commit=route.indexOf('await client.query("commit")');
    expect(begin).toBeGreaterThan(-1);
    for(const point of [journal,lines,group,allocation]){
      expect(point).toBeGreaterThan(begin);
      expect(point).toBeLessThan(commit);
    }
    expect(route).toContain('await client.query("rollback")');
    expect(route).toContain("client.release()");
  });

  it("fails closed when a posted Bank Disbursement owns a source journal",()=>{
    const sourceGuard=route.indexOf("const postedSourceDisbursement = await client.query");
    const journalInsert=route.indexOf("insert into public.accounting_entries");
    expect(sourceGuard).toBeGreaterThan(route.indexOf("for update"));
    expect(sourceGuard).toBeLessThan(journalInsert);
    const guardBlock=route.slice(sourceGuard,journalInsert);
    expect(guardBlock).toContain("public.bank_disbursement_items");
    expect(guardBlock).toContain("public.bank_disbursements");
    expect(guardBlock).toContain("public.accounting_entries");
    expect(guardBlock).toContain("bdi.vendor_invoice_id = any($1::bigint[])");
    expect(guardBlock).toContain("bd.company_id = $2");
    expect(guardBlock).toContain("bd.status = 'posted'");
    expect(guardBlock).toContain("bd.void_entry_id is null");
    expect(guardBlock).toContain("ae.status = 'posted'");
    expect(guardBlock).toContain("ae.cancelled_at is null");
    expect(guardBlock).toContain("ae.voided_at is null");
    expect(guardBlock).toContain("for update of bd");
    expect(guardBlock).toContain("[vendorInvoiceIds, companyId]");
    expect(guardBlock).toContain("VENDOR_INVOICE_SOURCE_JOURNAL_REUSE_REQUIRED");
  });

  it("requires a real mutation_id for canonical allocations, never a fabricated disbursement link",()=>{
    expect(route).toContain("mutation_id, allocated_amount");
    expect(route).toContain("mutationId,");
    expect(route).toContain("insert into public.bank_reconciliation_matches");
    expect(route).not.toContain("insert into public.bank_disbursements");
    expect(route).not.toContain("insert into public.bank_disbursement_items");
    expect(route).toContain("approved_pending_posting");
  });
});
