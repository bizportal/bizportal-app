-- Disposable Postgres fixture ONLY for Customer Invoice original-owner QA.
-- Requires generated Drizzle schema already installed. NEVER run on DEV/PROD.
-- Intentionally contains no customer, bank, payroll or production data.
DO $guard$
BEGIN
  IF current_database() <> 'invoice_synthetic' THEN
    RAISE EXCEPTION 'DISPOSABLE_ONLY: refusing schema parity on %', current_database();
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sales_documents LIMIT 1
  ) THEN
    RAISE EXCEPTION 'DISPOSABLE_ONLY: refusing nonempty invoice source';
  END IF;
END
$guard$;

CREATE TABLE public.journal_sequences (
  journal_prefix text NOT NULL,
  company_id integer NOT NULL DEFAULT 0,
  year integer NOT NULL,
  next_seq integer NOT NULL DEFAULT 1,
  PRIMARY KEY (journal_prefix, company_id, year)
);

CREATE TABLE public.financial_periods (
  id serial PRIMARY KEY,
  company_id integer NOT NULL,
  month integer NOT NULL,
  year integer NOT NULL,
  is_closed boolean NOT NULL DEFAULT false,
  override_allowed boolean NOT NULL DEFAULT false,
  closed_at timestamp,
  closed_by text,
  created_at timestamp NOT NULL DEFAULT now(),
  period_close_signature text,
  close_reason text
);

CREATE TABLE public.ledger_events (
  id serial PRIMARY KEY,
  company_id integer,
  report_id integer,
  event_type text NOT NULL,
  event_data jsonb,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  period text NOT NULL DEFAULT '',
  ledger_entry_id bigint,
  payload jsonb,
  governance_correlation_id text,
  ip_address text,
  user_role text,
  entry_id integer
);

CREATE TABLE public.financial_outbox_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  entry_id integer,
  company_id integer,
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE public.accounting_entries
  ADD COLUMN is_voided boolean NOT NULL DEFAULT false,
  ADD COLUMN is_reversed boolean NOT NULL DEFAULT false;

-- Source-idempotency guard, supplemental to original posting owner.
CREATE UNIQUE INDEX customer_invoice_synthetic_source_unique
  ON public.accounting_entries(company_id, source, source_id)
  WHERE source = 'sales_invoice' AND source_id IS NOT NULL;

DO $proof$
DECLARE missing text;
BEGIN
  SELECT string_agg(t.name, ', ' ORDER BY t.name) INTO missing
  FROM (VALUES
    ('journal_sequences'), ('financial_periods'),
    ('ledger_events'), ('financial_outbox_events')
  ) AS t(name)
  WHERE to_regclass('public.' || t.name) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'DISPOSABLE_SCHEMA_INCOMPLETE: %', missing;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounting_entries'
      AND column_name = 'is_voided'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounting_entries'
      AND column_name = 'is_reversed'
  ) THEN
    RAISE EXCEPTION 'DISPOSABLE_SCHEMA_INCOMPLETE: entry reversal flags';
  END IF;
END
$proof$;
