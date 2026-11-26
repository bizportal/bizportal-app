-- CST-DEV ONLY. Do NOT add to automatic PROD migrations.
-- Execute on an isolated DEV connection only after setting the explicit
-- session marker: SET cst.sc_cash_registry_dev = 'CST_DEV_EXPLICIT_20261127';
-- This script creates NEW document-evidence tables; it neither posts cash
-- nor imports historical Sheet Config #5.

DO $cash_guard$
BEGIN
  IF current_setting('cst.sc_cash_registry_dev', true)
       IS DISTINCT FROM 'CST_DEV_EXPLICIT_20261127' THEN
    RAISE EXCEPTION 'SC_FUTURE_CASH_REGISTRY_DEV_GATE_REQUIRED';
  END IF;
END
$cash_guard$;

CREATE TABLE IF NOT EXISTS public.sc_future_cash_documents (
  transaction_id uuid PRIMARY KEY,
  company_id integer NOT NULL DEFAULT 1 CHECK (company_id = 1),
  account_id integer NOT NULL DEFAULT 18 CHECK (account_id = 18),
  cash_coa_id integer NOT NULL DEFAULT 75839 CHECK (cash_coa_id = 75839),
  object_bucket text NOT NULL DEFAULT 'private-uploads'
    CHECK (object_bucket = 'private-uploads'),
  object_path text NOT NULL UNIQUE
    CHECK (object_path ~ '^/objects/uploads/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](pdf|png|jpg|jpeg|webp)$'),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  direction text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  transaction_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 8388608),
  uploaded_by text NOT NULL CHECK (length(btrim(uploaded_by)) BETWEEN 3 AND 254),
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Append-only verification/revocation; verification alone does not authorize posting.
CREATE TABLE IF NOT EXISTS public.sc_future_cash_document_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL
    REFERENCES public.sc_future_cash_documents(transaction_id),
  event_type text NOT NULL CHECK (event_type IN ('VERIFIED', 'REVOKED')),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  actor_email text NOT NULL CHECK (length(btrim(actor_email)) BETWEEN 3 AND 254),
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'super_admin')),
  event_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (transaction_id, event_type)
);

CREATE OR REPLACE FUNCTION public.sc_future_cash_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SC_FUTURE_CASH_EVIDENCE_APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS sc_cash_document_immutable
  ON public.sc_future_cash_documents;
CREATE TRIGGER sc_cash_document_immutable
BEFORE UPDATE OR DELETE ON public.sc_future_cash_documents
FOR EACH ROW EXECUTE FUNCTION public.sc_future_cash_reject_mutation();

DROP TRIGGER IF EXISTS sc_cash_event_immutable
  ON public.sc_future_cash_document_events;
CREATE TRIGGER sc_cash_event_immutable
BEFORE UPDATE OR DELETE ON public.sc_future_cash_document_events
FOR EACH ROW EXECUTE FUNCTION public.sc_future_cash_reject_mutation();

CREATE OR REPLACE FUNCTION public.sc_future_cash_validate_evidence_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row public.sc_future_cash_documents%ROWTYPE;
  has_verified boolean;
  has_revoked boolean;
BEGIN
  -- Lock the immutable document so concurrent verify/revoke cannot race.
  SELECT * INTO source_row
    FROM public.sc_future_cash_documents
   WHERE transaction_id = NEW.transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SC_FUTURE_CASH_DOCUMENT_NOT_FOUND';
  END IF;

  IF NEW.document_sha256 <> source_row.document_sha256
     OR NEW.source_fingerprint <> source_row.source_fingerprint THEN
    RAISE EXCEPTION 'SC_FUTURE_CASH_DOCUMENT_CHANGED';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.sc_future_cash_document_events
     WHERE transaction_id = NEW.transaction_id AND event_type = 'VERIFIED'
  ) INTO has_verified;
  SELECT EXISTS (
    SELECT 1 FROM public.sc_future_cash_document_events
     WHERE transaction_id = NEW.transaction_id AND event_type = 'REVOKED'
  ) INTO has_revoked;

  IF has_revoked OR (NEW.event_type = 'VERIFIED' AND has_verified)
       OR (NEW.event_type = 'REVOKED' AND NOT has_verified) THEN
    RAISE EXCEPTION 'SC_FUTURE_CASH_EVIDENCE_INVALID_TRANSITION';
  END IF;

  -- The server/database, not client metadata, determines the event timestamp.
  NEW.event_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sc_cash_event_transition_guard
  ON public.sc_future_cash_document_events;
CREATE TRIGGER sc_cash_event_transition_guard
BEFORE INSERT ON public.sc_future_cash_document_events
FOR EACH ROW EXECUTE FUNCTION public.sc_future_cash_validate_evidence_event();

-- No browser/anon policy. All access must pass through an authenticated,
-- company-scoped server-side repository using a controlled DB role.
ALTER TABLE public.sc_future_cash_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_future_cash_document_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sc_future_cash_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sc_future_cash_document_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sc_future_cash_documents FROM PUBLIC;
REVOKE ALL ON public.sc_future_cash_document_events FROM PUBLIC;
