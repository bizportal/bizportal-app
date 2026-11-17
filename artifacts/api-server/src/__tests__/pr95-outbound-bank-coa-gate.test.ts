import { describe, expect, it } from "vitest";
import { assertOutboundSourceBankCoa } from "../lib/outboundReuseBankCoaGate";
import type { OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

const scope={companyId:1,mutationId:90001,entryId:314,amountMinor:10000};
function fixture(
  bank: Array<{coa_id:number|null}>=[{coa_id:1023}],
  lines: Array<{credit_minor:string;debit_minor:string;line_count:string}>=[
    {credit_minor:"10000",debit_minor:"0",line_count:"1"},
  ],
) {
  const calls:Array<{sql:string;params:readonly (number|string)[]}>= [];
  const client:OutboundReuseQueryClient={
    async query<T extends Record<string,unknown>>(sql:string,params:readonly (number|string)[]) {
      calls.push({sql,params});
      return {rows:(calls.length===1?bank:lines) as unknown as T[]};
    },
  };
  return {client,calls};
}

describe("PR95 unregistered source-owned OUT bank COA gate",()=>{
  it("matches company-owned bank mapping against actual journal credit account",async()=>{
    const {client,calls}=fixture();
    await expect(assertOutboundSourceBankCoa(client,scope)).resolves.toBe(1023);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("company_bank_accounts");
    expect(calls[0].sql).toContain("cba.id::text=bm.bank_account_id");
    expect(calls[0].sql).toContain("for update of bm,cba");
    expect(calls[0].params).toEqual([90001,1]);
    expect(calls[1].sql).toContain("accounting_entry_lines");
    expect(calls[1].sql).toContain("chart_of_accounts");
    expect(calls[1].params).toEqual([314,1023,1]);
    expect(calls.every(x=>x.sql.trimStart().toLowerCase().startsWith("select"))).toBe(true);
  });
  it("rejects missing or ambiguous company bank mapping",async()=>{
    for (const rows of [[],[{coa_id:null}],[{coa_id:0}],[{coa_id:1023},{coa_id:1024}]]) {
      await expect(assertOutboundSourceBankCoa(fixture(rows).client,scope))
        .rejects.toThrow("PR95_BANK_COA_UNRESOLVED");
    }
  });
  it("rejects wrong source credit, foreign bank COA, duplicate bank lines and bank debits",async()=>{
    for (const row of [
      {credit_minor:"9900",debit_minor:"0",line_count:"1"},
      {credit_minor:"0",debit_minor:"0",line_count:"0"},
      {credit_minor:"10000",debit_minor:"50",line_count:"1"},
      {credit_minor:"10000",debit_minor:"0",line_count:"2"},
      {credit_minor:"NaN",debit_minor:"0",line_count:"1"},
    ]) {
      await expect(assertOutboundSourceBankCoa(fixture([{coa_id:1023}],[row]).client,scope))
        .rejects.toThrow("PR95_BANK_COA_SOURCE_MISMATCH");
    }
  });
  it("refuses unscoped or invalid amounts before any query",async()=>{
    const {client,calls}=fixture();
    await expect(assertOutboundSourceBankCoa(client,{...scope,companyId:0}))
      .rejects.toThrow("PR95_BANK_COA_INVALID_SCOPE");
    await expect(assertOutboundSourceBankCoa(client,{...scope,amountMinor:100.5}))
      .rejects.toThrow("PR95_BANK_COA_INVALID_SCOPE");
    expect(calls).toHaveLength(0);
  });
});
