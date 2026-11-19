-- NETWORK/DATABASE-ISOLATED QA ONLY: invoice_synthetic in a disposable PG16.
-- Fake roles/rights exist ONLY inside the destroyed QA container. NEVER CST-DEV/PROD.
DO $guard$ BEGIN
 IF current_database()<>'invoice_synthetic' THEN
  RAISE EXCEPTION 'DISPOSABLE_ONLY_NO_HOSTED_DB';
 END IF;
END $guard$;

CREATE ROLE bizportal_customer_invoice_cst_writer_dev LOGIN PASSWORD 'synthetic-only-pass' NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE bizportal_customer_invoice_diva_writer_dev LOGIN PASSWORD 'synthetic-only-pass' NOINHERIT NOSUPERUSER NOBYPASSRLS;
ALTER TABLE public.users ADD COLUMN updated_at timestamptz DEFAULT now();
INSERT INTO public.users(id,email,role,system_role,status,is_active,company_id)
 VALUES
 ('synthetic-staff-cst','qa-issuer-cst@example.invalid','admin',null,'active',true,1),
 ('synthetic-staff-diva','qa-issuer-diva@example.invalid','admin',null,'active',true,3);
-- Existing original PR142 QA has synthetic-owner (global Super Admin).
UPDATE public.users SET email='qa-owner@example.invalid' WHERE id='synthetic-owner';
INSERT INTO public.bizportal_customer_ar_source_actors_dev(role_name,company_id,verified_source,source_not_before,enabled)
VALUES
 ('bizportal_customer_invoice_cst_writer_dev',1,'disposable original-owner OTP QA',clock_timestamp()-interval '5 minutes',true),
 ('bizportal_customer_invoice_diva_writer_dev',3,'disposable original-owner OTP QA',clock_timestamp()-interval '5 minutes',true);

INSERT INTO public.sales_documents(
 id,doc_number,kind,status,invoice_status,payment_status,
 customer_name,total_amount,tax_amount,grand_total,company_id,
 invoice_number,invoice_date,due_date,tax_treatment,tax_rate_id
) VALUES
 (201,'QA-ORDER-201','order','confirmed','to_invoice','unpaid','Synthetic CST Live Owner E2E',100,11,111,1,null,null,null,'exclusive',1),
 (203,'QA-ORDER-203','order','confirmed','to_invoice','unpaid','Synthetic Diva Live Owner E2E',100,11,111,3,null,null,null,'exclusive',3),
 (205,'QA-ORDER-205','order','confirmed','to_invoice','unpaid','Synthetic rejected Owner OTP',100,11,111,1,null,null,null,'exclusive',1);
INSERT INTO public.sales_document_lines(document_id,name,quantity,unit_price,subtotal)
VALUES (201,'Synthetic tax service CST',1,100,100),
       (203,'Synthetic tax service Diva',1,100,100),
       (205,'Synthetic rejected tax service',1,100,100);

GRANT USAGE ON SCHEMA public TO bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
-- These broad QA-only SQL grants are to ephemeral throwaway synthetic
-- schema. The actual hosted CST-DEV grants remain minimal/unchanged.
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public
 TO bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public
 TO bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
-- The original reviewed AR trigger is SECURITY INVOKER and refuses an
-- unknown/hidden source actor. The legacy fixture exposes actor self-read
-- only to Finance roles. Add ONLY these synthetic Invoice roles here.
CREATE POLICY qa_invoice_actor_self_read ON public.bizportal_customer_ar_source_actors_dev
 FOR SELECT TO bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev
 USING (current_user=session_user AND role_name=session_user);

-- Financial-sensitive RLS checks are never bypassed. All scoped role sessions
-- must have CURRENT_USER=SESSION_USER and can only see matching company.
DO $policies$
DECLARE rec record; role_name text; company int; predicate text;
BEGIN
 FOR rec IN
  SELECT x.table_name FROM (VALUES
   ('sales_documents'),('accounting_entries'),('accounting_entry_lines'),
   ('ar_subledger'),('transaction_taxes'),('audit_accounting_events'),
   ('financial_outbox_events'),('accounting_settings'),('accounting_taxes'),
   ('accounting_journals'),('chart_of_accounts'),('ledger_events')
  ) x(table_name)
 LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',rec.table_name);
  FOREACH company IN ARRAY ARRAY[1,3] LOOP
   role_name=CASE company WHEN 1 THEN 'bizportal_customer_invoice_cst_writer_dev'
       ELSE 'bizportal_customer_invoice_diva_writer_dev' END;
   IF rec.table_name='accounting_entry_lines' THEN
      predicate=format('(current_user=session_user AND EXISTS (SELECT 1 FROM public.accounting_entries p WHERE p.id=entry_id AND p.company_id=%s))',company);
   ELSE
      predicate=format('(current_user=session_user AND company_id=%s)',company);
   END IF;
   EXECUTE format('CREATE POLICY qa_original_owner_scope_%s ON public.%I FOR ALL TO %I USING %s WITH CHECK %s',
      company,rec.table_name,role_name,predicate,predicate);
  END LOOP;
 END LOOP;
END $policies$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.users TO bizportal_customer_invoice_cst_writer_dev,bizportal_customer_invoice_diva_writer_dev;
-- QA prohibits modifying identities despite broad disposable table grants.
CREATE POLICY qa_user_read_cst ON public.users FOR SELECT TO bizportal_customer_invoice_cst_writer_dev
 USING (current_user=session_user AND (company_id=1 OR (company_id IS NULL AND role='super_admin' AND system_role='super_admin')));
CREATE POLICY qa_user_read_diva ON public.users FOR SELECT TO bizportal_customer_invoice_diva_writer_dev
 USING (current_user=session_user AND (company_id=3 OR (company_id IS NULL AND role='super_admin' AND system_role='super_admin')));
CREATE POLICY qa_user_update_cst ON public.users FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev
 USING (current_user=session_user AND (company_id=1 OR (company_id IS NULL AND role='super_admin' AND system_role='super_admin')))
 WITH CHECK (false);
CREATE POLICY qa_user_update_diva ON public.users FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev
 USING (current_user=session_user AND (company_id=3 OR (company_id IS NULL AND role='super_admin' AND system_role='super_admin')))
 WITH CHECK (false);

-- Deliberately assert non-bypass with actual direct-login credentials.
DO $checks$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM pg_roles
  WHERE rolname IN ('bizportal_customer_invoice_cst_writer_dev','bizportal_customer_invoice_diva_writer_dev')
  AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls;
 IF n<>2 THEN RAISE EXCEPTION 'DISPOSABLE_WRITER_IDENTITY_INVALID'; END IF;
END $checks$;
