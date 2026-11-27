-- USE ONLY WITH LOCALHOST PORT 55497 disposable PostgreSQL test database.
-- Complements an OFFLINE-generated Drizzle Marketplace schema; DO NOT APPLY TO SUPABASE.
create table if not exists public.mkt_payment_approval_audit_dev (
 id bigserial primary key,company_id integer not null,
 payment_request_id integer not null references public.payment_requests(id),
 actor_email text not null,decision text not null,created_at timestamptz default now(),
 unique(payment_request_id)
);
create table if not exists public.bank_mutations (
 id integer primary key,company_id integer,direction text,status text,
 accounting_posted boolean,reconciliation_status text,journal_entry_id integer,
 import_row_id integer,import_batch_id integer,source_table text,source_module text,
 source_id integer,linked_transaction_type text,linked_transaction_id integer,
 amount numeric,bank_account_id text,approved_at timestamptz,
 posted_at timestamptz,review_code text,review_reason text,updated_at timestamptz
);
create table if not exists public.bank_reconciliation_matches (
 id integer primary key,mutation_id integer,candidate_type text,
 candidate_source text,candidate_id text,status text
);
create table if not exists public.payment_matching_groups (
 id integer primary key,company_id integer,status text,
 total_allocated numeric,remaining_amount numeric
);
create table if not exists public.payment_allocations (
 id integer primary key,group_id integer,company_id integer,
 invoice_id integer,mutation_id integer,allocated_amount numeric,is_active boolean
);
create table if not exists public.accounting_entries (
 id integer primary key,company_id integer,source text,source_id integer,
 status text,total_debit numeric,total_credit numeric,posted_at timestamptz
);
create table if not exists public.accounting_entry_lines (
 id integer primary key,entry_id integer,company_id integer,
 account_id integer,debit numeric,credit numeric
);
create table if not exists public.company_bank_accounts (
 id integer primary key,company_id integer,account_number text,coa_id integer,is_active boolean
);
create table if not exists public.chart_of_accounts (
 id integer primary key,company_id integer,is_active boolean,is_postable boolean
);
create table if not exists public.bank_reconciliation_audit (
 id bigserial primary key,mutation_id integer,action text,actor text,meta jsonb
);
create table if not exists public.audit_logs (
 id bigserial primary key,user_email text,action text,entity_type text,
 entity_id text,company_id text,module text,after_data jsonb
);
