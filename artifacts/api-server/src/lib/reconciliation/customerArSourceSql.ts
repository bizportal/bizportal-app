/**
 * Existing sales invoice / journal evidence, shared by the read-only preview
 * and the reviewed DEV database projection. No payment or journal is written.
 * Keep the view body in customer_ar_source_dev_INSTALL_REVIEW.sql identical;
 * the PostgreSQL integration test checks this and executes both consumers.
 */
export const CUSTOMER_AR_SOURCE_EVIDENCE_SQL = `
select sd.id as invoice_id, sd.company_id, sd.customer_id,
       sd.invoice_number, sd.invoice_date, sd.due_date,
       sd.grand_total::numeric as gross_amount,
       sd.amount_paid::numeric as paid_amount,
       (sd.grand_total - sd.amount_paid)::numeric as outstanding_amount,
       case when sd.amount_paid = sd.grand_total then 'PAID'
            when sd.amount_paid > 0 then 'PARTIAL' else 'OPEN' end as ar_status,
       entry.id as gl_entry_id, (entry.created_at AT TIME ZONE 'UTC') as source_created_at
from public.sales_documents sd
join public.accounting_settings settings on settings.company_id = sd.company_id
join public.chart_of_accounts ar_account on ar_account.id = settings.ar_account_id
  and ar_account.company_id = sd.company_id
  and ar_account.type::text = 'asset' and ar_account.subtype::text = 'receivable'
  and ar_account.is_active is true and ar_account.is_postable is true
  and ar_account.is_header is false
join public.accounting_journals journal on journal.id = settings.sales_journal_id
  and journal.company_id = sd.company_id and journal.type::text = 'sales'
join public.accounting_entries entry on entry.company_id = sd.company_id
  and entry.source::text = 'sales_invoice' and entry.source_id = sd.id
  and entry.journal_id = journal.id and entry.status::text = 'posted'
  and entry.is_voided is false and entry.is_reversed is false
  and entry.void_entry_id is null
join lateral (
  select count(*) as line_count,
         bool_and(account.id is not null
           and account.company_id = sd.company_id
           and (line.company_id is null or line.company_id = sd.company_id)
           and line.debit >= 0 and line.credit >= 0
           and line.debit::text not in ('NaN', 'Infinity', '-Infinity')
           and line.credit::text not in ('NaN', 'Infinity', '-Infinity')
           and (line.debit = 0 or line.credit = 0)) as lines_valid,
         sum(line.debit)::numeric as total_debit,
         sum(line.credit)::numeric as total_credit,
         coalesce(sum(line.debit) filter (where line.account_id = ar_account.id), 0)::numeric as ar_debit,
         coalesce(sum(line.credit) filter (where line.account_id = ar_account.id), 0)::numeric as ar_credit
  from public.accounting_entry_lines line
  left join public.chart_of_accounts account on account.id = line.account_id
  where line.entry_id = entry.id
) proof on proof.line_count >= 2 and proof.lines_valid is true
  and proof.total_debit = sd.grand_total and proof.total_credit = sd.grand_total
  and proof.ar_debit = sd.grand_total and proof.ar_credit = 0
  and entry.total_debit = proof.total_debit and entry.total_credit = proof.total_credit
where sd.invoice_status::text = 'invoiced' and sd.status::text in ('confirmed', 'done')
  and sd.cancelled_at is null
  and nullif(btrim(sd.invoice_number), '') is not null
  and sd.invoice_date is not null and sd.due_date >= sd.invoice_date
  and sd.grand_total::text not in ('NaN', 'Infinity', '-Infinity')
  and sd.amount_paid::text not in ('NaN', 'Infinity', '-Infinity')
  and sd.grand_total > 0 and sd.amount_paid >= 0 and sd.amount_paid <= sd.grand_total
  and ((sd.amount_paid = 0 and sd.payment_status::text in ('unpaid', 'overdue'))
    or (sd.amount_paid > 0 and sd.amount_paid < sd.grand_total and sd.payment_status::text in ('partial', 'overdue'))
    or (sd.amount_paid = sd.grand_total and sd.payment_status::text = 'paid'))
  and (select count(*) from public.accounting_settings other_settings
       where other_settings.company_id = sd.company_id) = 1
  and (select count(*) from public.accounting_entries other_entry
       where other_entry.company_id = sd.company_id
         and other_entry.source::text = 'sales_invoice' and other_entry.source_id = sd.id) = 1
  and (select count(*) from public.sales_documents other_invoice
       where other_invoice.company_id = sd.company_id
         and upper(btrim(other_invoice.invoice_number)) = upper(btrim(sd.invoice_number))) = 1
  and not exists (
    select 1 from public.accounting_entries reversal
    where reversal.company_id = sd.company_id and reversal.source::text = 'reversal'
      and reversal.source_id in (sd.id, entry.id) and reversal.journal_id = entry.journal_id
      and reversal.status::text = 'posted' and reversal.is_voided is false
      and reversal.is_reversed is false
  )`;

/** A stale, foreign, duplicated or changed AR projection never proves a match. */
export const CUSTOMER_AR_INVOICES_SQL = `
with evidence as (${CUSTOMER_AR_SOURCE_EVIDENCE_SQL})
select sd.id, sd.company_id, sd.invoice_number, sd.customer_name,
       sd.invoice_status::text as invoice_status, sd.status::text as document_status,
       sd.payment_status::text as payment_status,
       ar.outstanding_amount::text as outstanding_amount,
       coalesce(ar.journal_posted, false) as ar_journal_posted
from public.sales_documents sd
left join lateral (
  select max(ledger.outstanding_amount)::numeric as outstanding_amount,
         count(*) = 1 and bool_and(
           evidence.gl_entry_id is not null
           and ledger.gl_entry_id = evidence.gl_entry_id
           and ledger.gross_amount = evidence.gross_amount
           and ledger.paid_amount = evidence.paid_amount
           and ledger.outstanding_amount = evidence.outstanding_amount
           and ledger.customer_id is not distinct from evidence.customer_id
           and ledger.period = to_char(evidence.invoice_date, 'YYYY-MM')
           and ledger.invoice_number = evidence.invoice_number
           and ledger.invoice_date = evidence.invoice_date
           and ledger.due_date = evidence.due_date
           and ledger.currency = 'IDR' and ledger.status = evidence.ar_status
         ) as journal_posted
  from public.ar_subledger ledger
  left join evidence on evidence.company_id = ledger.company_id
    and evidence.invoice_id = ledger.invoice_id
  where ledger.company_id = sd.company_id and ledger.invoice_id = sd.id
) ar on true
where sd.company_id = $1 and sd.invoice_status::text = 'invoiced'
  and sd.status::text not in ('cancelled', 'canceled', 'void')
  and sd.cancelled_at is null
order by sd.id desc limit 300`;
