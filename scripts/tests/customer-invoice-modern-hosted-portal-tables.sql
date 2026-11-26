-- Disposable PG16 only. These Customer Portal tables exist on hosted
-- CST-DEV but are absent from original BizPortal's 86-table ORM QA fixture.
-- Minimal synthetic shapes are sufficient for exact column-GRANT parity.
DO $guard$ BEGIN
 IF current_database()<>'invoice_synthetic' THEN
  RAISE EXCEPTION 'DISPOSABLE_ONLY';
 END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS public.portal_customers(
 id serial PRIMARY KEY,
 email text NOT NULL,
 role text NOT NULL DEFAULT 'customer',
 account_status text NOT NULL DEFAULT 'active',
 status_changed_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.portal_company_members(
 id serial PRIMARY KEY,
 portal_customer_id integer NOT NULL,
 company_id integer NOT NULL,
 is_active boolean NOT NULL DEFAULT true,
 updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.portal_customer_notifications(
 id serial PRIMARY KEY,
 portal_customer_id integer NOT NULL,
 event_key text NOT NULL,
 type text NOT NULL,
 title text NOT NULL,
 message text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE(portal_customer_id,event_key)
);
INSERT INTO public.portal_customers(id,name,email,role,account_status) VALUES
(501,'Synthetic Global Owner Portal Admin','qa-owner@example.invalid','admin','active'),
(503,'Synthetic Diva Admin','qa-issuer-diva@example.invalid','admin','active'),
(504,'Synthetic Unassigned Admin','qa-unassigned@example.invalid','admin','active');
INSERT INTO public.portal_company_members(portal_customer_id,company_id,is_active)
VALUES (501,1,true),(503,3,true);
