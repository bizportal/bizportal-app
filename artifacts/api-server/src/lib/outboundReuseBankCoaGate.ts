/**
 * PR95 read-only bank identity verification, NOT a posting/approval adapter.
 * Query on the same authenticated, company-scoped transaction client that
 * already locked the bank mutation and posted source journal.
 */
import type { OutboundReuseQueryClient } from "./outboundReuseFinalityReader";

export async function assertOutboundSourceBankCoa(
  tx: OutboundReuseQueryClient,
  scope: { companyId: number; mutationId: number; entryId: number; amountMinor: number },
): Promise<number> {
  if (![scope.companyId, scope.mutationId, scope.entryId, scope.amountMinor]
    .every(v => Number.isSafeInteger(v) && v > 0)) {
    throw Error("PR95_BANK_COA_INVALID_SCOPE");
  }

  const mapped = await tx.query<{ coa_id: number | null }>(
    `select cba.coa_id
       from public.bank_mutations bm
       join public.company_bank_accounts cba on cba.id::text=bm.bank_account_id
      where bm.id=$1 and bm.company_id=$2
        and cba.company_id=$2 and cba.is_active=true and cba.coa_id is not null
      for update of bm,cba`,
    [scope.mutationId, scope.companyId],
  );
  const coaId = Number(mapped.rows[0]?.coa_id);
  if (mapped.rows.length !== 1 || !Number.isSafeInteger(coaId) || coaId <= 0) {
    throw Error("PR95_BANK_COA_UNRESOLVED");
  }

  const credit = await tx.query<{ credit_minor: string; debit_minor: string; line_count: string }>(
    `select coalesce(sum(round(el.credit*100)),0)::text as credit_minor,
            coalesce(sum(round(el.debit*100)),0)::text as debit_minor,
            count(*)::text as line_count
       from public.accounting_entry_lines el
       join public.chart_of_accounts coa on coa.id=el.account_id
      where el.entry_id=$1 and el.account_id=$2
        and (coa.company_id=$3 or coa.company_id is null)
        and coa.is_active=true`,
    [scope.entryId, coaId, scope.companyId],
  );
  const row = credit.rows[0];
  const creditMinor = Number(row?.credit_minor);
  const debitMinor = Number(row?.debit_minor);
  if (!row || Number(row.line_count) !== 1
    || !Number.isSafeInteger(creditMinor) || !Number.isSafeInteger(debitMinor)
    || creditMinor !== scope.amountMinor || debitMinor !== 0) {
    throw Error("PR95_BANK_COA_SOURCE_MISMATCH");
  }
  return coaId;
}
