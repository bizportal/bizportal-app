-- REVIEW ONLY / CST-DEV project xssrfshdrtdfupgqwfdw.
-- NOT auto-applied. Scoped role update only; NO payment/GL/PROD write grants.
begin;
create table if not exists public.mkt_payment_approval_audit_dev (
 id bigint generated always as identity primary key,
 company_id integer not null,
 payment_request_id integer not null references public.payment_requests(id),
 actor_email text not null,
 decision text not null check (decision='approved'),
 created_at timestamptz not null default now(),
 unique(payment_request_id)
);
alter table public.mkt_payment_approval_audit_dev enable row level security;
revoke all on public.mkt_payment_approval_audit_dev from public;
grant select,insert on public.mkt_payment_approval_audit_dev to
 bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
grant usage,select on sequence public.mkt_payment_approval_audit_dev_id_seq to
 bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
create policy mkt_approval_audit_company_insert_dev
 on public.mkt_payment_approval_audit_dev for insert to
 bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
 with check (
  company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
  and actor_email <> '' and decision='approved'
  and exists(select 1 from public.payment_requests pr
    where pr.id=payment_request_id and pr.company_id=company_id
      and pr.source_type='marketplace_ap' and pr.status='approved')
 );
create policy mkt_approval_audit_company_read_dev
 on public.mkt_payment_approval_audit_dev for select to
 bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
 using(company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer);
grant update (status,approved_by,approved_at,mkt_approved_by,mkt_approved_at,
 mkt_treasury_ready_by,mkt_treasury_ready_at,mkt_lifecycle_status)
 on public.payment_requests to
 bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev;
create policy pr166_marketplace_payment_approval_update_dev
 on public.payment_requests for update to
 bizportal_finance_cst_login_dev,bizportal_finance_diva_login_dev
 using(company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
   and source_type='marketplace_ap' and status in ('draft','approved')
   and paid_amount=0 and journal_entry_id is null)
 with check(company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer
   and source_type='marketplace_ap' and status='approved'
   and approved_by is not null and approved_at is not null
   and mkt_approved_by is not null and mkt_approved_at is not null
   and mkt_treasury_ready_by is not null and mkt_treasury_ready_at is not null
   and mkt_lifecycle_status='treasury_ready'
   and paid_amount=0 and journal_entry_id is null);
commit;
