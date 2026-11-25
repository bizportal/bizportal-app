-- Isolated LOCALHOST PostgreSQL finance_approval_qa ONLY.
-- DO NOT run on business CST-DEV Supabase or on any PROD database.
-- The route refuses any other database URL.
create table if not exists public.qa_po14_e2e_runs (
  id bigint generated always as identity primary key,
  reference text not null,
  company_id integer not null check(company_id=1),
  actor text not null,
  status text not null check(status='completed'),
  steps jsonb not null,
  amount numeric(18,2) not null check(amount=100000.00),
  created_at timestamptz not null default now(),
  unique(reference,company_id)
);
create table if not exists public.qa_po14_e2e_audit (
  id bigint generated always as identity primary key,
  run_id bigint not null references public.qa_po14_e2e_runs(id),
  actor text not null,
  action text not null check(action='sandbox_run_recorded'),
  created_at timestamptz not null default now(),
  unique(run_id,action)
);
