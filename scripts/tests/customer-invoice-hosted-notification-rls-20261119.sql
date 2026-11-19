-- READ-ONLY CST-DEV pg_policies snapshot 2026-11-19. DISPOSABLE QA PG16 ONLY.
-- This is NOT a migration. Never execute against hosted CST-DEV or PROD.
DO $guard$ BEGIN IF current_database()<>'invoice_synthetic' THEN RAISE EXCEPTION 'DISPOSABLE_ONLY'; END IF; END $guard$;
ALTER TABLE public.portal_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_customer_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cst_invoice_b4_guard_cst ON public.activity_logs AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (actor_type = 'admin'::text) AND (action = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (activity_logs.deduplication_key = ('sales-invoice-issued:'::text || (sd.id)::text))))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (actor_type = 'admin'::text) AND (action = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (activity_logs.deduplication_key = ('sales-invoice-issued:'::text || (sd.id)::text)))))));
CREATE POLICY cst_invoice_b4_guard_diva ON public.activity_logs AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (actor_type = 'admin'::text) AND (action = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (activity_logs.deduplication_key = ('sales-invoice-issued:'::text || (sd.id)::text))))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (actor_type = 'admin'::text) AND (action = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (activity_logs.deduplication_key = ('sales-invoice-issued:'::text || (sd.id)::text)))))));
CREATE POLICY cst_invoice_b4_insert_cst ON public.activity_logs AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (actor_type = 'admin'::text) AND (action = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (activity_logs.deduplication_key = ('sales-invoice-issued:'::text || (sd.id)::text)))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.activity_logs AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (actor_type = 'admin'::text) AND (action = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (activity_logs.deduplication_key = ('sales-invoice-issued:'::text || (sd.id)::text)))))));
CREATE POLICY cst_invoice_b4_read_cst ON public.activity_logs AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (actor_type = 'admin'::text) AND (action = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (activity_logs.deduplication_key = ('sales-invoice-issued:'::text || (sd.id)::text)))))));
CREATE POLICY cst_invoice_b4_read_diva ON public.activity_logs AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (actor_type = 'admin'::text) AND (action = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (activity_logs.deduplication_key = ('sales-invoice-issued:'::text || (sd.id)::text)))))));
CREATE POLICY cst_invoice_b2_guard_cst ON public.portal_company_members AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (is_active IS TRUE))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (is_active IS TRUE)));
CREATE POLICY cst_invoice_b2_guard_diva ON public.portal_company_members AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (is_active IS TRUE))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (is_active IS TRUE)));
CREATE POLICY cst_invoice_b2_read_cst ON public.portal_company_members AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (is_active IS TRUE)));
CREATE POLICY cst_invoice_b2_read_diva ON public.portal_company_members AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (is_active IS TRUE)));
CREATE POLICY cst_invoice_b3_ownerlock_cst ON public.portal_company_members AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (is_active IS TRUE))) WITH CHECK (false);
CREATE POLICY cst_invoice_b3_ownerlock_diva ON public.portal_company_members AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (is_active IS TRUE))) WITH CHECK (false);
CREATE POLICY cst_invoice_b4_guard_cst ON public.portal_customer_notifications AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (type = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (portal_customer_notifications.event_key = (('sales-invoice:'::text || (sd.id)::text) || ':invoiced'::text)) AND ((portal_customer_notifications.payload ->> 'invoiceId'::text) = (sd.id)::text)))) AND (EXISTS ( SELECT 1
   FROM portal_customers pc
  WHERE ((pc.id = portal_customer_notifications.portal_customer_id) AND (((pc.role = 'admin'::text) AND ((pc.account_status = 'active'::text) OR (pc.account_status IS NULL))) OR (EXISTS ( SELECT 1
           FROM portal_company_members pcm
          WHERE ((pcm.portal_customer_id = pc.id) AND (pcm.company_id = 1) AND (pcm.is_active IS TRUE)))))))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (type = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (portal_customer_notifications.event_key = (('sales-invoice:'::text || (sd.id)::text) || ':invoiced'::text)) AND ((portal_customer_notifications.payload ->> 'invoiceId'::text) = (sd.id)::text)))) AND (EXISTS ( SELECT 1
   FROM portal_customers pc
  WHERE ((pc.id = portal_customer_notifications.portal_customer_id) AND (((pc.role = 'admin'::text) AND ((pc.account_status = 'active'::text) OR (pc.account_status IS NULL))) OR (EXISTS ( SELECT 1
           FROM portal_company_members pcm
          WHERE ((pcm.portal_customer_id = pc.id) AND (pcm.company_id = 1) AND (pcm.is_active IS TRUE))))))))));
CREATE POLICY cst_invoice_b4_guard_diva ON public.portal_customer_notifications AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (type = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (portal_customer_notifications.event_key = (('sales-invoice:'::text || (sd.id)::text) || ':invoiced'::text)) AND ((portal_customer_notifications.payload ->> 'invoiceId'::text) = (sd.id)::text)))) AND (EXISTS ( SELECT 1
   FROM portal_customers pc
  WHERE ((pc.id = portal_customer_notifications.portal_customer_id) AND (((pc.role = 'admin'::text) AND ((pc.account_status = 'active'::text) OR (pc.account_status IS NULL))) OR (EXISTS ( SELECT 1
           FROM portal_company_members pcm
          WHERE ((pcm.portal_customer_id = pc.id) AND (pcm.company_id = 3) AND (pcm.is_active IS TRUE)))))))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (type = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (portal_customer_notifications.event_key = (('sales-invoice:'::text || (sd.id)::text) || ':invoiced'::text)) AND ((portal_customer_notifications.payload ->> 'invoiceId'::text) = (sd.id)::text)))) AND (EXISTS ( SELECT 1
   FROM portal_customers pc
  WHERE ((pc.id = portal_customer_notifications.portal_customer_id) AND (((pc.role = 'admin'::text) AND ((pc.account_status = 'active'::text) OR (pc.account_status IS NULL))) OR (EXISTS ( SELECT 1
           FROM portal_company_members pcm
          WHERE ((pcm.portal_customer_id = pc.id) AND (pcm.company_id = 3) AND (pcm.is_active IS TRUE))))))))));
CREATE POLICY cst_invoice_b4_insert_cst ON public.portal_customer_notifications AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (type = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (portal_customer_notifications.event_key = (('sales-invoice:'::text || (sd.id)::text) || ':invoiced'::text)) AND ((portal_customer_notifications.payload ->> 'invoiceId'::text) = (sd.id)::text)))) AND (EXISTS ( SELECT 1
   FROM portal_customers pc
  WHERE ((pc.id = portal_customer_notifications.portal_customer_id) AND (((pc.role = 'admin'::text) AND ((pc.account_status = 'active'::text) OR (pc.account_status IS NULL))) OR (EXISTS ( SELECT 1
           FROM portal_company_members pcm
          WHERE ((pcm.portal_customer_id = pc.id) AND (pcm.company_id = 1) AND (pcm.is_active IS TRUE))))))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.portal_customer_notifications AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (type = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (portal_customer_notifications.event_key = (('sales-invoice:'::text || (sd.id)::text) || ':invoiced'::text)) AND ((portal_customer_notifications.payload ->> 'invoiceId'::text) = (sd.id)::text)))) AND (EXISTS ( SELECT 1
   FROM portal_customers pc
  WHERE ((pc.id = portal_customer_notifications.portal_customer_id) AND (((pc.role = 'admin'::text) AND ((pc.account_status = 'active'::text) OR (pc.account_status IS NULL))) OR (EXISTS ( SELECT 1
           FROM portal_company_members pcm
          WHERE ((pcm.portal_customer_id = pc.id) AND (pcm.company_id = 3) AND (pcm.is_active IS TRUE))))))))));
CREATE POLICY cst_invoice_b4_read_cst ON public.portal_customer_notifications AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (type = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (portal_customer_notifications.event_key = (('sales-invoice:'::text || (sd.id)::text) || ':invoiced'::text)) AND ((portal_customer_notifications.payload ->> 'invoiceId'::text) = (sd.id)::text)))) AND (EXISTS ( SELECT 1
   FROM portal_customers pc
  WHERE ((pc.id = portal_customer_notifications.portal_customer_id) AND (((pc.role = 'admin'::text) AND ((pc.account_status = 'active'::text) OR (pc.account_status IS NULL))) OR (EXISTS ( SELECT 1
           FROM portal_company_members pcm
          WHERE ((pcm.portal_customer_id = pc.id) AND (pcm.company_id = 1) AND (pcm.is_active IS TRUE))))))))));
CREATE POLICY cst_invoice_b4_read_diva ON public.portal_customer_notifications AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (type = 'sales_invoice_issued'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (portal_customer_notifications.event_key = (('sales-invoice:'::text || (sd.id)::text) || ':invoiced'::text)) AND ((portal_customer_notifications.payload ->> 'invoiceId'::text) = (sd.id)::text)))) AND (EXISTS ( SELECT 1
   FROM portal_customers pc
  WHERE ((pc.id = portal_customer_notifications.portal_customer_id) AND (((pc.role = 'admin'::text) AND ((pc.account_status = 'active'::text) OR (pc.account_status IS NULL))) OR (EXISTS ( SELECT 1
           FROM portal_company_members pcm
          WHERE ((pcm.portal_customer_id = pc.id) AND (pcm.company_id = 3) AND (pcm.is_active IS TRUE))))))))));
CREATE POLICY cst_invoice_b2_guard_cst ON public.portal_customers AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (((role = 'admin'::text) AND ((account_status = 'active'::text) OR (account_status IS NULL))) OR (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND (sd.customer_id = portal_customers.id))))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (((role = 'admin'::text) AND ((account_status = 'active'::text) OR (account_status IS NULL))) OR (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND (sd.customer_id = portal_customers.id)))))));
CREATE POLICY cst_invoice_b2_guard_diva ON public.portal_customers AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (((role = 'admin'::text) AND ((account_status = 'active'::text) OR (account_status IS NULL))) OR (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND (sd.customer_id = portal_customers.id))))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (((role = 'admin'::text) AND ((account_status = 'active'::text) OR (account_status IS NULL))) OR (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND (sd.customer_id = portal_customers.id)))))));
CREATE POLICY cst_invoice_b2_read_cst ON public.portal_customers AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (((role = 'admin'::text) AND ((account_status = 'active'::text) OR (account_status IS NULL))) OR (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 1) AND (sd.customer_id = portal_customers.id)))))));
CREATE POLICY cst_invoice_b2_read_diva ON public.portal_customers AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (((role = 'admin'::text) AND ((account_status = 'active'::text) OR (account_status IS NULL))) OR (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.company_id = 3) AND (sd.customer_id = portal_customers.id)))))));
CREATE POLICY cst_invoice_b3_ownerlock_cst ON public.portal_customers AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role = 'admin'::text) AND ((account_status = 'active'::text) OR (account_status IS NULL)))) WITH CHECK (false);
CREATE POLICY cst_invoice_b3_ownerlock_diva ON public.portal_customers AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role = 'admin'::text) AND ((account_status = 'active'::text) OR (account_status IS NULL)))) WITH CHECK (false);
