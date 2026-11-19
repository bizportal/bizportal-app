-- Disposable invoice_synthetic ONLY. Mimics the hosted Portal payment
-- source columns/enum types, without bank integration, real settlement,
-- credentials or PROD changes. Original Accounting and AR trigger reused.
DO $guard$ BEGIN IF current_database()<>'invoice_synthetic' THEN
 RAISE EXCEPTION 'DISPOSABLE_ONLY';END IF;END $guard$;

DO $types$ BEGIN
 IF to_regtype('public.payment_ref_kind') IS NULL THEN
   CREATE TYPE public.payment_ref_kind AS ENUM ('sales','purchase');
 END IF;
 IF to_regtype('public.payment_status') IS NULL THEN
   CREATE TYPE public.payment_status AS ENUM ('pending','paid','failed','expired','cancelled');
 END IF;
 IF to_regtype('public.payment_provider') IS NULL THEN
   CREATE TYPE public.payment_provider AS ENUM ('paylabs');
 END IF;
END $types$;

CREATE TABLE IF NOT EXISTS public.payments(
 id integer PRIMARY KEY,
 ref_kind public.payment_ref_kind NOT NULL,
 ref_id integer NOT NULL,
 ref_doc_number text NOT NULL,
 amount numeric NOT NULL,
 status public.payment_status NOT NULL DEFAULT 'pending',
 provider public.payment_provider NOT NULL DEFAULT 'paylabs',
 provider_order_id text,
 provider_merchant_trade_no text NOT NULL,
 payment_method text,
 payment_url text,
 expired_at timestamp,
 paid_at timestamp,
 created_at timestamp NOT NULL DEFAULT now(),
 updated_at timestamp NOT NULL DEFAULT now(),
 company_id integer
);

INSERT INTO public.payments(
 id,ref_kind,ref_id,ref_doc_number,amount,status,provider,
 provider_merchant_trade_no,payment_method,company_id
) VALUES
 (7001,'sales',201,'QA-ORDER-201',40,'pending','paylabs','QA-PAY-7001','bank',1),
 (7003,'sales',203,'QA-ORDER-203',40,'pending','paylabs','QA-PAY-7003','bank',3),
 (7005,'sales',201,'QA-ORDER-201',5,'pending','paylabs','QA-MISMATCH-7005','bank',3),
 (7007,'sales',205,'QA-ORDER-205',5,'pending','paylabs','QA-UNISSUED-7007','bank',1);

-- Current PR142 original Accounting fixture has no payment endpoint trigger.
-- Any AR projection due to payment updates must arise from the existing
-- previously installed reviewed AR after-source trigger, not a new writer.
