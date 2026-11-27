-- REVIEW / APPLY ONLY to the existing localhost Finance QA database.
-- The application separately pins 127.0.0.1:55495; a Docker server may have a bridge address.
do $qa$
begin
  if current_database() <> 'finance_approval_qa' then
    raise exception 'PO14 real browser receipt requires finance_approval_qa';
  end if;
end;
$qa$;

-- The old qa_po14_e2e_runs contains SIMULATED receipts and remains unchanged.
create table if not exists public.qa_po14_real_e2e_runs (
  id uuid primary key,
  reference text not null check(reference='PO-20261117-00014'),
  company_id integer not null check(company_id=1),
  actor text not null,
  contract_version smallint not null check(contract_version=2),
  amount numeric(18,2) not null check(amount=100000.00),
  worker_sha256 text not null check(worker_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb not null check(jsonb_typeof(evidence)='object'),
  created_at timestamptz not null default now(),
  unique(reference,company_id,contract_version,worker_sha256)
);
create table if not exists public.qa_po14_real_e2e_audit (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.qa_po14_real_e2e_runs(id),
  actor text not null,
  action text not null check(action='real_service_sql_verified'),
  created_at timestamptz not null default now(),
  unique(run_id,action)
);
