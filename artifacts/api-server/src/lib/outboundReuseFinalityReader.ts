/**
 * Read-only custody counts for the unregistered PR95 outbound source reuse gate.
 * Must run using the SAME transaction-scoped PG client as subsequent locks.
 * These SELECTs alone do not authorize approval, allocation or posting.
 */
export interface OutboundReuseQueryClient {
  query<T extends Record<string, unknown>>(statement: string, parameters: readonly (string | number)[]):
    Promise<{ rows: T[] }>;
}

export type OutboundReuseFinalityCounts = Readonly<{
  mutationFinalMatchCount: number;
  sourceFinalAllocationCount: number;
  activeApprovedMutationLinkCount: number;
}>;

function count(row: { n?: unknown } | undefined): number {
  const n = Number(row?.n);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("PR95_FINALITY_COUNT_INVALID");
  return n;
}

/**
 * Only call after authenticating and locking the mutation, invoice,
 * source journal, and company in the same transaction.
 */
export async function readOutboundReuseFinalityCounts(
  client: OutboundReuseQueryClient,
  input: { companyId: number; mutationId: number; invoiceId: number; entryId: number },
): Promise<OutboundReuseFinalityCounts> {
  if (![input.companyId, input.mutationId, input.invoiceId, input.entryId]
    .every(v => Number.isSafeInteger(v) && v > 0)) {
    throw new Error("PR95_FINALITY_SCOPE_INVALID");
  }
  const matches = await client.query<{ n: string }>(
    `select count(*)::text as n from public.bank_reconciliation_matches
      where mutation_id=$1 and lower(status) in ('approved','posted')`,
    [input.mutationId],
  );
  const allocations = await client.query<{ n: string }>(
    `select count(*)::text as n
       from public.payment_allocations pa
       left join public.payment_matching_groups pmg on pmg.id=pa.group_id
       left join public.bank_mutations bm on bm.id=pa.mutation_id
      where pa.company_id=$1 and pa.invoice_id=$2
        and coalesce(pa.is_active,true)=true
        and (lower(coalesce(pmg.status,'')) in ('final','posted','reconciled')
          or lower(coalesce(bm.status,'')) in ('final','posted','reconciled'))`,
    [input.companyId,input.invoiceId],
  );
  const linked = await client.query<{ n: string }>(
    `select count(*)::text as n from public.bank_mutations
      where company_id=$1 and journal_entry_id=$2`,
    [input.companyId,input.entryId],
  );
  return {
    mutationFinalMatchCount: count(matches.rows[0]),
    sourceFinalAllocationCount: count(allocations.rows[0]),
    activeApprovedMutationLinkCount: count(linked.rows[0]),
  };
}
