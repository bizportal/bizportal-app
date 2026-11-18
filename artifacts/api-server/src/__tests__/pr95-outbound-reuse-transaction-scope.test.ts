import { describe, expect, it } from "vitest";
import { lockOutboundSourceJournalReuseScope } from "../lib/outboundReuseTransactionScope";
import type { OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

const ids = { companyId: 1, mutationId: 90001, invoiceId: 7 };
function build(overrides: { mutation?: Record<string, unknown> | null; invoice?: boolean; bd?: {id:number;entry_id:number|null}[]; entry?: boolean; counts?: number[]; sourceItems?: Array<{vendor_invoice_id:number|null;amount?:string}>; lineItems?: Array<{debit:string;credit:string}>; amount?: string; header?: string } = {}) {
  const seen: Array<{sql:string;params:readonly (string|number)[]}> = [];
  let n=0;
  const client: OutboundReuseQueryClient = {
    async query<T extends Record<string,unknown>>(sql:string,params:readonly (string|number)[]) {
      seen.push({sql,params});
      const row = sql.includes("pg_advisory_xact_lock") ? [{}]
        : sql.includes("from public.bank_mutations where id=") ?
          (overrides.mutation === null ? [] : [overrides.mutation ?? {id:90001,company_id:1,direction:"OUT",status:"unmatched",journal_entry_id:null,amount:overrides.amount??"100.00",debit_amount:"0.00",credit_amount:overrides.amount??"100.00"}])
        : sql.includes("from public.vendor_invoices") ? (overrides.invoice === false ? [] : [{id:7}])
        : sql.includes("from public.bank_disbursements") ? (overrides.bd ?? [{id:2,entry_id:314}])
        : sql.includes("from public.bank_disbursement_items") ? (overrides.sourceItems ?? [{vendor_invoice_id:7,amount:"100.00"}])
        : sql.includes("from public.accounting_entries") ? (overrides.entry === false ? [] : [{id:314,total_debit:overrides.header??"100.00",total_credit:overrides.header??"100.00"}])
        : sql.includes("join public.company_bank_accounts") ? [{coa_id:1023}]
        : sql.includes("join public.chart_of_accounts") ? [{credit_minor:"10000",debit_minor:"0",line_count:"1"}]
        : sql.includes("from public.accounting_entry_lines") ? (overrides.lineItems ?? [{debit:"100.00",credit:"0.00"},{debit:"0.00",credit:"100.00"}])
        : [{n:String((overrides.counts ?? [0,0,0])[n++])}];
      return {rows:row as unknown as T[]};
    },
  };
  return {client,seen};
}
describe("PR95 unregistered PostgreSQL lock-scoped outbound reuse preflight", () => {
  it("takes company-scoped mutation and invoice locks before source checks and finality reads", async () => {
    const {client,seen}=build();
    await expect(lockOutboundSourceJournalReuseScope(client,ids)).resolves.toEqual({
      mutationId:90001,invoiceId:7,disbursementId:2,sourceEntryId:314,verifiedAmountMinor:10000,
      finality:{mutationFinalMatchCount:0,sourceFinalAllocationCount:0,activeApprovedMutationLinkCount:0},
    });
    expect(seen[0].sql).toContain("pg_advisory_xact_lock");
    expect(seen[1].sql).toContain("pg_advisory_xact_lock");
    expect(seen[2].sql).toContain("bank_mutations");
    expect(seen[2].sql).toContain("for update");
    expect(seen[2].params).toEqual([90001,1]);
    expect(seen[3].sql).toContain("vendor_invoices");
    expect(seen[3].sql).toContain("for update");
    expect(seen[3].params).toEqual([7,1]);
    expect(seen[4].sql).toContain("for update of bd,bdi");
    expect(seen[5].sql).toContain("from public.bank_disbursement_items");
    expect(seen[5].sql).toContain("for update");
    expect(seen[5].params).toEqual([2]);
    expect(seen[6].sql).toContain("from public.accounting_entries");
    expect(seen[6].sql).toContain("for update");
    expect(seen[7].sql).toContain("from public.accounting_entry_lines");
    expect(seen[7].sql).toContain("for update");
    expect(seen[8].sql).toContain("company_bank_accounts");
    expect(seen[9].sql).toContain("chart_of_accounts");
    expect(seen.slice(10)).toHaveLength(3);
    expect(seen.every(q=>!/(insert into|update public|delete from)/i.test(q.sql))).toBe(true);
  });
  it("rejects mismatch of mutation, disbursement, and source ledger amounts", async () => {
    for (const overrides of [
      { amount:"99.99" },
      { sourceItems:[{vendor_invoice_id:7,amount:"99.99"}] },
      { header:"99.99" },
      { lineItems:[{debit:"99.99",credit:"0.00"},{debit:"0.00",credit:"99.99"}] },
    ]) await expect(lockOutboundSourceJournalReuseScope(build(overrides).client,ids))
      .rejects.toThrow("PR95_OUTBOUND_LEDGER_MISMATCH");
    await expect(lockOutboundSourceJournalReuseScope(build({amount:"100.001"}).client,ids))
      .rejects.toThrow("PR95_OUTBOUND_AMOUNT_INVALID");
  });
  it("rejects missing actual mutation, wrong direction, prelinked journal, and invalid company input", async () => {
    await expect(lockOutboundSourceJournalReuseScope(build().client,{...ids,companyId:0})).rejects.toThrow("PR95_OUTBOUND_LOCK_SCOPE_INVALID");
    for(const mutation of [null,{direction:"IN",journal_entry_id:null,status:"unmatched"},{direction:"OUT",journal_entry_id:314,status:"matched"}]){
      const {client}=build({mutation});
      await expect(lockOutboundSourceJournalReuseScope(client,ids)).rejects.toThrow("PR95_OUTBOUND_MUTATION_NOT_ELIGIBLE");
    }
  });
  it("rejects unposted invoice, multiple source payments, invalid journal and finalized custody", async () => {
    await expect(lockOutboundSourceJournalReuseScope(build({invoice:false}).client,ids))
      .rejects.toThrow("PR95_OUTBOUND_INVOICE_NOT_POSTED");
    await expect(lockOutboundSourceJournalReuseScope(build({bd:[{id:2,entry_id:314},{id:3,entry_id:315}]}).client,ids))
      .rejects.toThrow("PR95_OUTBOUND_SOURCE_AMBIGUOUS");
    await expect(lockOutboundSourceJournalReuseScope(build({sourceItems:[{vendor_invoice_id:7},{vendor_invoice_id:8}]}).client,ids))
      .rejects.toThrow("PR95_OUTBOUND_SOURCE_MULTI_INVOICE");
    await expect(lockOutboundSourceJournalReuseScope(build({sourceItems:[]}).client,ids))
      .rejects.toThrow("PR95_OUTBOUND_SOURCE_MULTI_INVOICE");
    await expect(lockOutboundSourceJournalReuseScope(build({entry:false}).client,ids))
      .rejects.toThrow("PR95_OUTBOUND_SOURCE_JOURNAL_INVALID");
    for (const counts of [[1,0,0],[0,1,0],[0,0,1]]) {
      await expect(lockOutboundSourceJournalReuseScope(build({counts}).client,ids))
        .rejects.toThrow("PR95_OUTBOUND_FINALIZED_CUSTODY_EXISTS");
    }
  });
});
