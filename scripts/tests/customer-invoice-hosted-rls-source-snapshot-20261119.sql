-- QA only. CST-DEV RLS policy metadata captured with SELECT, no customer rows.
-- Exact 122 per-role B1/B2/B3/B4 policy definitions across 21 Invoice tables.
-- NEVER apply to hosted CST-DEV or PROD. Guarded to disposable PG16 DB.
DO $guard$ BEGIN IF current_database()<>'invoice_synthetic' THEN RAISE EXCEPTION 'DISPOSABLE_ONLY'; END IF; END $guard$;
ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.accounting_entries;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.accounting_entries;
ALTER TABLE public.accounting_entry_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.accounting_entry_lines;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.accounting_entry_lines;
ALTER TABLE public.accounting_journals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.accounting_journals;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.accounting_journals;
ALTER TABLE public.accounting_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.accounting_settings;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.accounting_settings;
ALTER TABLE public.accounting_taxes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.accounting_taxes;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.accounting_taxes;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.activity_logs;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.activity_logs;
ALTER TABLE public.ar_subledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.ar_subledger;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.ar_subledger;
ALTER TABLE public.audit_accounting_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.audit_accounting_events;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.audit_accounting_events;
ALTER TABLE public.bizportal_customer_ar_source_actors_dev ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.bizportal_customer_ar_source_actors_dev;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.bizportal_customer_ar_source_actors_dev;
DROP POLICY IF EXISTS qa_invoice_actor_self_read ON public.bizportal_customer_ar_source_actors_dev;
ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.chart_of_accounts;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.chart_of_accounts;
ALTER TABLE public.financial_outbox_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.financial_outbox_events;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.financial_outbox_events;
ALTER TABLE public.financial_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.financial_periods;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.financial_periods;
ALTER TABLE public.journal_sequences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.journal_sequences;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.journal_sequences;
ALTER TABLE public.ledger_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.ledger_events;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.ledger_events;
ALTER TABLE public.portal_company_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.portal_company_members;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.portal_company_members;
ALTER TABLE public.portal_customer_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.portal_customer_notifications;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.portal_customer_notifications;
ALTER TABLE public.portal_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.portal_customers;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.portal_customers;
ALTER TABLE public.sales_document_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.sales_document_lines;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.sales_document_lines;
ALTER TABLE public.sales_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.sales_documents;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.sales_documents;
ALTER TABLE public.transaction_taxes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.transaction_taxes;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.transaction_taxes;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_original_owner_scope_1 ON public.users;
DROP POLICY IF EXISTS qa_original_owner_scope_3 ON public.users;
DROP POLICY IF EXISTS qa_user_read_cst ON public.users;
DROP POLICY IF EXISTS qa_user_read_diva ON public.users;
DROP POLICY IF EXISTS qa_user_update_cst ON public.users;
DROP POLICY IF EXISTS qa_user_update_diva ON public.users;
CREATE POLICY cst_invoice_b1_guard_cst ON public.accounting_entries AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND ((source)::text = 'sales_invoice'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND ((source)::text = 'sales_invoice'::text)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.accounting_entries AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND ((source)::text = 'sales_invoice'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND ((source)::text = 'sales_invoice'::text)));
CREATE POLICY cst_invoice_b1_read_cst ON public.accounting_entries AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND ((source)::text = 'sales_invoice'::text)));
CREATE POLICY cst_invoice_b1_read_diva ON public.accounting_entries AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND ((source)::text = 'sales_invoice'::text)));
CREATE POLICY cst_invoice_b4_insert_cst ON public.accounting_entries AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND ((source)::text = 'sales_invoice'::text) AND ((status)::text = 'draft'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.id = accounting_entries.source_id) AND (sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND ((sd.status)::text = ANY (ARRAY['confirmed'::text, 'done'::text, 'completed'::text])) AND (sd.invoice_number = accounting_entries.ref) AND (accounting_entries.date = sd.invoice_date) AND (accounting_entries.total_debit = sd.grand_total) AND (accounting_entries.total_credit = sd.grand_total) AND (EXISTS ( SELECT 1
           FROM accounting_settings cfg
          WHERE ((cfg.company_id = 1) AND (cfg.sales_journal_id = accounting_entries.journal_id)))) AND (sd.cancelled_at IS NULL))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.accounting_entries AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND ((source)::text = 'sales_invoice'::text) AND ((status)::text = 'draft'::text) AND (EXISTS ( SELECT 1
   FROM sales_documents sd
  WHERE ((sd.id = accounting_entries.source_id) AND (sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND ((sd.status)::text = ANY (ARRAY['confirmed'::text, 'done'::text, 'completed'::text])) AND (sd.invoice_number = accounting_entries.ref) AND (accounting_entries.date = sd.invoice_date) AND (accounting_entries.total_debit = sd.grand_total) AND (accounting_entries.total_credit = sd.grand_total) AND (EXISTS ( SELECT 1
           FROM accounting_settings cfg
          WHERE ((cfg.company_id = 3) AND (cfg.sales_journal_id = accounting_entries.journal_id)))) AND (sd.cancelled_at IS NULL))))));
CREATE POLICY cst_invoice_b4_update_cst ON public.accounting_entries AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND ((source)::text = 'sales_invoice'::text) AND ((status)::text = 'draft'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND ((source)::text = 'sales_invoice'::text) AND ((status)::text = ANY (ARRAY['posted'::text, 'rejected'::text]))));
CREATE POLICY cst_invoice_b4_update_diva ON public.accounting_entries AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND ((source)::text = 'sales_invoice'::text) AND ((status)::text = 'draft'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND ((source)::text = 'sales_invoice'::text) AND ((status)::text = ANY (ARRAY['posted'::text, 'rejected'::text]))));
CREATE POLICY cst_invoice_b1_guard_cst ON public.accounting_entry_lines AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = accounting_entry_lines.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = accounting_entry_lines.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_guard_diva ON public.accounting_entry_lines AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = accounting_entry_lines.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = accounting_entry_lines.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_read_cst ON public.accounting_entry_lines AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = accounting_entry_lines.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_read_diva ON public.accounting_entry_lines AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = accounting_entry_lines.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b4_insert_cst ON public.accounting_entry_lines AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND ((company_id IS NULL) OR (company_id = 1)) AND (debit >= (0)::numeric) AND (credit >= (0)::numeric) AND ((debit = (0)::numeric) OR (credit = (0)::numeric)) AND (EXISTS ( SELECT 1
   FROM ((accounting_entries p
     JOIN sales_documents sd ON (((sd.id = p.source_id) AND (sd.company_id = p.company_id))))
     JOIN accounting_settings cfg ON ((cfg.company_id = p.company_id)))
  WHERE ((p.id = accounting_entry_lines.entry_id) AND (p.company_id = 1) AND ((p.source)::text = 'sales_invoice'::text) AND ((p.status)::text = 'draft'::text) AND (((accounting_entry_lines.account_id = cfg.ar_account_id) AND (accounting_entry_lines.debit = sd.grand_total) AND (accounting_entry_lines.credit = (0)::numeric)) OR ((accounting_entry_lines.account_id = cfg.sales_income_account_id) AND (accounting_entry_lines.credit = sd.total_amount) AND (accounting_entry_lines.debit = (0)::numeric)) OR ((sd.tax_amount > (0)::numeric) AND (accounting_entry_lines.account_id = cfg.ppn_output_account_id) AND (accounting_entry_lines.credit = sd.tax_amount) AND (accounting_entry_lines.debit = (0)::numeric))))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.accounting_entry_lines AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND ((company_id IS NULL) OR (company_id = 3)) AND (debit >= (0)::numeric) AND (credit >= (0)::numeric) AND ((debit = (0)::numeric) OR (credit = (0)::numeric)) AND (EXISTS ( SELECT 1
   FROM ((accounting_entries p
     JOIN sales_documents sd ON (((sd.id = p.source_id) AND (sd.company_id = p.company_id))))
     JOIN accounting_settings cfg ON ((cfg.company_id = p.company_id)))
  WHERE ((p.id = accounting_entry_lines.entry_id) AND (p.company_id = 3) AND ((p.source)::text = 'sales_invoice'::text) AND ((p.status)::text = 'draft'::text) AND (((accounting_entry_lines.account_id = cfg.ar_account_id) AND (accounting_entry_lines.debit = sd.grand_total) AND (accounting_entry_lines.credit = (0)::numeric)) OR ((accounting_entry_lines.account_id = cfg.sales_income_account_id) AND (accounting_entry_lines.credit = sd.total_amount) AND (accounting_entry_lines.debit = (0)::numeric)) OR ((sd.tax_amount > (0)::numeric) AND (accounting_entry_lines.account_id = cfg.ppn_output_account_id) AND (accounting_entry_lines.credit = sd.tax_amount) AND (accounting_entry_lines.debit = (0)::numeric))))))));
CREATE POLICY cst_invoice_b1_guard_cst ON public.accounting_journals AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.accounting_journals AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_read_cst ON public.accounting_journals AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_read_diva ON public.accounting_journals AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_guard_cst ON public.accounting_settings AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.accounting_settings AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_read_cst ON public.accounting_settings AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_read_diva ON public.accounting_settings AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_guard_cst ON public.accounting_taxes AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.accounting_taxes AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_read_cst ON public.accounting_taxes AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_read_diva ON public.accounting_taxes AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
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
CREATE POLICY cst_invoice_b1_guard_cst ON public.ar_subledger AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (notes = 'bizportal:customer-ar-source:v1'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (notes = 'bizportal:customer-ar-source:v1'::text)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.ar_subledger AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (notes = 'bizportal:customer-ar-source:v1'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (notes = 'bizportal:customer-ar-source:v1'::text)));
CREATE POLICY cst_invoice_b1_read_cst ON public.ar_subledger AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (notes = 'bizportal:customer-ar-source:v1'::text)));
CREATE POLICY cst_invoice_b1_read_diva ON public.ar_subledger AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (notes = 'bizportal:customer-ar-source:v1'::text)));
CREATE POLICY cst_invoice_b4_insert_cst ON public.ar_subledger AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (notes = 'bizportal:customer-ar-source:v1'::text) AND (currency = 'IDR'::text) AND (EXISTS ( SELECT 1
   FROM bizportal_customer_ar_source_actors_dev actor
  WHERE ((actor.role_name = SESSION_USER) AND (actor.company_id = 1) AND actor.enabled))) AND (EXISTS ( SELECT 1
   FROM bizportal_customer_ar_source_evidence_dev e
  WHERE ((e.company_id = ar_subledger.company_id) AND (e.invoice_id = ar_subledger.invoice_id) AND (e.gl_entry_id = ar_subledger.gl_entry_id) AND (e.invoice_number = ar_subledger.invoice_number) AND (e.gross_amount = ar_subledger.gross_amount) AND (e.paid_amount = ar_subledger.paid_amount) AND (e.outstanding_amount = ar_subledger.outstanding_amount))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.ar_subledger AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (notes = 'bizportal:customer-ar-source:v1'::text) AND (currency = 'IDR'::text) AND (EXISTS ( SELECT 1
   FROM bizportal_customer_ar_source_actors_dev actor
  WHERE ((actor.role_name = SESSION_USER) AND (actor.company_id = 3) AND actor.enabled))) AND (EXISTS ( SELECT 1
   FROM bizportal_customer_ar_source_evidence_dev e
  WHERE ((e.company_id = ar_subledger.company_id) AND (e.invoice_id = ar_subledger.invoice_id) AND (e.gl_entry_id = ar_subledger.gl_entry_id) AND (e.invoice_number = ar_subledger.invoice_number) AND (e.gross_amount = ar_subledger.gross_amount) AND (e.paid_amount = ar_subledger.paid_amount) AND (e.outstanding_amount = ar_subledger.outstanding_amount))))));
CREATE POLICY cst_invoice_b4_update_cst ON public.ar_subledger AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (notes = 'bizportal:customer-ar-source:v1'::text) AND (EXISTS ( SELECT 1
   FROM bizportal_customer_ar_source_actors_dev actor
  WHERE ((actor.role_name = SESSION_USER) AND (actor.company_id = 1) AND actor.enabled))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (notes = 'bizportal:customer-ar-source:v1'::text) AND ((status = 'STALE'::text) OR (EXISTS ( SELECT 1
   FROM bizportal_customer_ar_source_evidence_dev e
  WHERE ((e.company_id = ar_subledger.company_id) AND (e.invoice_id = ar_subledger.invoice_id) AND (e.gl_entry_id = ar_subledger.gl_entry_id)))))));
CREATE POLICY cst_invoice_b4_update_diva ON public.ar_subledger AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (notes = 'bizportal:customer-ar-source:v1'::text) AND (EXISTS ( SELECT 1
   FROM bizportal_customer_ar_source_actors_dev actor
  WHERE ((actor.role_name = SESSION_USER) AND (actor.company_id = 3) AND actor.enabled))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (notes = 'bizportal:customer-ar-source:v1'::text) AND ((status = 'STALE'::text) OR (EXISTS ( SELECT 1
   FROM bizportal_customer_ar_source_evidence_dev e
  WHERE ((e.company_id = ar_subledger.company_id) AND (e.invoice_id = ar_subledger.invoice_id) AND (e.gl_entry_id = ar_subledger.gl_entry_id)))))));
CREATE POLICY cst_invoice_b1_guard_cst ON public.audit_accounting_events AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (correlation_id ~~ 'sales_invoice:1:%'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (correlation_id ~~ 'sales_invoice:1:%'::text)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.audit_accounting_events AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (correlation_id ~~ 'sales_invoice:3:%'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (correlation_id ~~ 'sales_invoice:3:%'::text)));
CREATE POLICY cst_invoice_b1_read_cst ON public.audit_accounting_events AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (correlation_id ~~ 'sales_invoice:1:%'::text)));
CREATE POLICY cst_invoice_b1_read_diva ON public.audit_accounting_events AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (correlation_id ~~ 'sales_invoice:3:%'::text)));
CREATE POLICY cst_invoice_b4_insert_cst ON public.audit_accounting_events AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = audit_accounting_events.journal_id) AND (e.company_id = 1) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text) AND (audit_accounting_events.correlation_id = ((((('sales_invoice:'::text || (1)::text) || ':'::text) || (e.source_id)::text) || ':'::text) || (e.id)::text)))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.audit_accounting_events AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = audit_accounting_events.journal_id) AND (e.company_id = 3) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text) AND (audit_accounting_events.correlation_id = ((((('sales_invoice:'::text || (3)::text) || ':'::text) || (e.source_id)::text) || ':'::text) || (e.id)::text)))))));
CREATE POLICY cst_invoice_b4_rowlock_cst ON public.audit_accounting_events AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = audit_accounting_events.journal_id) AND (e.company_id = 1) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text) AND (audit_accounting_events.correlation_id = ((((('sales_invoice:'::text || (1)::text) || ':'::text) || (e.source_id)::text) || ':'::text) || (e.id)::text))))))) WITH CHECK (false);
CREATE POLICY cst_invoice_b4_rowlock_diva ON public.audit_accounting_events AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (action = 'SALES_INVOICE_ISSUED'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = audit_accounting_events.journal_id) AND (e.company_id = 3) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text) AND (audit_accounting_events.correlation_id = ((((('sales_invoice:'::text || (3)::text) || ':'::text) || (e.source_id)::text) || ':'::text) || (e.id)::text))))))) WITH CHECK (false);
CREATE POLICY cst_invoice_b1_guard_cst ON public.bizportal_customer_ar_source_actors_dev AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role_name = SESSION_USER) AND (company_id = 1))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (role_name = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.bizportal_customer_ar_source_actors_dev AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role_name = SESSION_USER) AND (company_id = 3))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (role_name = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_read_cst ON public.bizportal_customer_ar_source_actors_dev AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role_name = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_read_diva ON public.bizportal_customer_ar_source_actors_dev AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role_name = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_guard_cst ON public.chart_of_accounts AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.chart_of_accounts AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_read_cst ON public.chart_of_accounts AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_read_diva ON public.chart_of_accounts AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_guard_cst ON public.financial_outbox_events AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = financial_outbox_events.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = financial_outbox_events.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_guard_diva ON public.financial_outbox_events AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = financial_outbox_events.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = financial_outbox_events.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_read_cst ON public.financial_outbox_events AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = financial_outbox_events.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_read_diva ON public.financial_outbox_events AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = financial_outbox_events.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b4_insert_cst ON public.financial_outbox_events AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = financial_outbox_events.entry_id) AND (e.company_id = 1) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.financial_outbox_events AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = financial_outbox_events.entry_id) AND (e.company_id = 3) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text))))));
CREATE POLICY cst_invoice_b4_rowlock_cst ON public.financial_outbox_events AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = financial_outbox_events.entry_id) AND (e.company_id = 1) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text)))))) WITH CHECK (false);
CREATE POLICY cst_invoice_b4_rowlock_diva ON public.financial_outbox_events AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'JOURNAL_CREATED'::text) AND ((payload ->> 'sourceType'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = financial_outbox_events.entry_id) AND (e.company_id = 3) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text)))))) WITH CHECK (false);
CREATE POLICY cst_invoice_b1_guard_cst ON public.financial_periods AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.financial_periods AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_read_cst ON public.financial_periods AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_read_diva ON public.financial_periods AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_guard_cst ON public.journal_sequences AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.journal_sequences AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_read_cst ON public.journal_sequences AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_read_diva ON public.journal_sequences AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b4_insert_cst ON public.journal_sequences AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (EXISTS ( SELECT 1
   FROM (accounting_settings s
     JOIN accounting_journals j ON ((j.id = s.sales_journal_id)))
  WHERE ((s.company_id = 1) AND (j.company_id = 1) AND (j.code = journal_sequences.journal_prefix))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.journal_sequences AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (EXISTS ( SELECT 1
   FROM (accounting_settings s
     JOIN accounting_journals j ON ((j.id = s.sales_journal_id)))
  WHERE ((s.company_id = 3) AND (j.company_id = 3) AND (j.code = journal_sequences.journal_prefix))))));
CREATE POLICY cst_invoice_b4_update_cst ON public.journal_sequences AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (EXISTS ( SELECT 1
   FROM (accounting_settings s
     JOIN accounting_journals j ON ((j.id = s.sales_journal_id)))
  WHERE ((s.company_id = 1) AND (j.company_id = 1) AND (j.code = journal_sequences.journal_prefix)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (EXISTS ( SELECT 1
   FROM (accounting_settings s
     JOIN accounting_journals j ON ((j.id = s.sales_journal_id)))
  WHERE ((s.company_id = 1) AND (j.company_id = 1) AND (j.code = journal_sequences.journal_prefix))))));
CREATE POLICY cst_invoice_b4_update_diva ON public.journal_sequences AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (EXISTS ( SELECT 1
   FROM (accounting_settings s
     JOIN accounting_journals j ON ((j.id = s.sales_journal_id)))
  WHERE ((s.company_id = 3) AND (j.company_id = 3) AND (j.code = journal_sequences.journal_prefix)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (EXISTS ( SELECT 1
   FROM (accounting_settings s
     JOIN accounting_journals j ON ((j.id = s.sales_journal_id)))
  WHERE ((s.company_id = 3) AND (j.company_id = 3) AND (j.code = journal_sequences.journal_prefix))))));
CREATE POLICY cst_invoice_b1_guard_cst ON public.ledger_events AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'POST'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = ledger_events.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'POST'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = ledger_events.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_guard_diva ON public.ledger_events AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'POST'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = ledger_events.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'POST'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = ledger_events.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_read_cst ON public.ledger_events AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'POST'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = ledger_events.entry_id) AND (parent.company_id = 1) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b1_read_diva ON public.ledger_events AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'POST'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries parent
  WHERE ((parent.id = ledger_events.entry_id) AND (parent.company_id = 3) AND ((parent.source)::text = 'sales_invoice'::text))))));
CREATE POLICY cst_invoice_b4_insert_cst ON public.ledger_events AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (event_type = 'POST'::text) AND ((payload ->> 'source'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = ledger_events.entry_id) AND (e.company_id = 1) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.ledger_events AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (event_type = 'POST'::text) AND ((payload ->> 'source'::text) = 'sales_invoice'::text) AND (EXISTS ( SELECT 1
   FROM accounting_entries e
  WHERE ((e.id = ledger_events.entry_id) AND (e.company_id = 3) AND ((e.source)::text = 'sales_invoice'::text) AND ((e.status)::text = 'posted'::text))))));
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
CREATE POLICY cst_invoice_b1_guard_cst ON public.sales_document_lines AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM sales_documents source
  WHERE ((source.id = sales_document_lines.document_id) AND (source.company_id = 1)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM sales_documents source
  WHERE ((source.id = sales_document_lines.document_id) AND (source.company_id = 1))))));
CREATE POLICY cst_invoice_b1_guard_diva ON public.sales_document_lines AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM sales_documents source
  WHERE ((source.id = sales_document_lines.document_id) AND (source.company_id = 3)))))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM sales_documents source
  WHERE ((source.id = sales_document_lines.document_id) AND (source.company_id = 3))))));
CREATE POLICY cst_invoice_b1_read_cst ON public.sales_document_lines AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM sales_documents source
  WHERE ((source.id = sales_document_lines.document_id) AND (source.company_id = 1))))));
CREATE POLICY cst_invoice_b1_read_diva ON public.sales_document_lines AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (EXISTS ( SELECT 1
   FROM sales_documents source
  WHERE ((source.id = sales_document_lines.document_id) AND (source.company_id = 3))))));
CREATE POLICY cst_invoice_b1_guard_cst ON public.sales_documents AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.sales_documents AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b1_read_cst ON public.sales_documents AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1)));
CREATE POLICY cst_invoice_b1_read_diva ON public.sales_documents AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3)));
CREATE POLICY cst_invoice_b4_update_cst ON public.sales_documents AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND ((status)::text = ANY (ARRAY['confirmed'::text, 'done'::text, 'completed'::text])) AND ((invoice_status)::text = ANY (ARRAY['to_invoice'::text, 'invoiced'::text])) AND (cancelled_at IS NULL))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND ((invoice_status)::text = 'invoiced'::text) AND (cancelled_at IS NULL)));
CREATE POLICY cst_invoice_b4_update_diva ON public.sales_documents AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND ((status)::text = ANY (ARRAY['confirmed'::text, 'done'::text, 'completed'::text])) AND ((invoice_status)::text = ANY (ARRAY['to_invoice'::text, 'invoiced'::text])) AND (cancelled_at IS NULL))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND ((invoice_status)::text = 'invoiced'::text) AND (cancelled_at IS NULL)));
CREATE POLICY cst_invoice_b1_guard_cst ON public.transaction_taxes AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (transaction_type = 'sales_invoice'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (transaction_type = 'sales_invoice'::text)));
CREATE POLICY cst_invoice_b1_guard_diva ON public.transaction_taxes AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (transaction_type = 'sales_invoice'::text))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (transaction_type = 'sales_invoice'::text)));
CREATE POLICY cst_invoice_b1_read_cst ON public.transaction_taxes AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (transaction_type = 'sales_invoice'::text)));
CREATE POLICY cst_invoice_b1_read_diva ON public.transaction_taxes AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (transaction_type = 'sales_invoice'::text)));
CREATE POLICY cst_invoice_b4_insert_cst ON public.transaction_taxes AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_cst_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 1) AND (transaction_type = 'sales_invoice'::text) AND (status = 'posted'::text) AND (direction = 'output'::text) AND (tax_amount > (0)::numeric) AND (EXISTS ( SELECT 1
   FROM (sales_documents sd
     JOIN accounting_settings cfg ON ((cfg.company_id = sd.company_id)))
  WHERE ((sd.id = transaction_taxes.transaction_id) AND (sd.company_id = 1) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (sd.tax_rate_id = transaction_taxes.tax_id) AND (sd.tax_amount = transaction_taxes.tax_amount) AND (cfg.default_sales_tax_id = transaction_taxes.tax_id) AND (cfg.ppn_output_account_id = transaction_taxes.account_id))))));
CREATE POLICY cst_invoice_b4_insert_diva ON public.transaction_taxes AS PERMISSIVE FOR INSERT TO bizportal_customer_invoice_diva_writer_dev WITH CHECK (((CURRENT_USER = SESSION_USER) AND (company_id = 3) AND (transaction_type = 'sales_invoice'::text) AND (status = 'posted'::text) AND (direction = 'output'::text) AND (tax_amount > (0)::numeric) AND (EXISTS ( SELECT 1
   FROM (sales_documents sd
     JOIN accounting_settings cfg ON ((cfg.company_id = sd.company_id)))
  WHERE ((sd.id = transaction_taxes.transaction_id) AND (sd.company_id = 3) AND ((sd.invoice_status)::text = 'invoiced'::text) AND (sd.tax_rate_id = transaction_taxes.tax_id) AND (sd.tax_amount = transaction_taxes.tax_amount) AND (cfg.default_sales_tax_id = transaction_taxes.tax_id) AND (cfg.ppn_output_account_id = transaction_taxes.account_id))))));
CREATE POLICY cst_invoice_b2_guard_cst ON public.users AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role = 'super_admin'::text) AND (system_role = 'super_admin'::text) AND (status = 'active'::text) AND (is_active IS TRUE) AND ((company_id IS NULL) OR (company_id = 1)))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (role = 'super_admin'::text) AND (system_role = 'super_admin'::text) AND (status = 'active'::text) AND (is_active IS TRUE) AND ((company_id IS NULL) OR (company_id = 1))));
CREATE POLICY cst_invoice_b2_guard_diva ON public.users AS RESTRICTIVE FOR ALL TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role = 'super_admin'::text) AND (system_role = 'super_admin'::text) AND (status = 'active'::text) AND (is_active IS TRUE) AND ((company_id IS NULL) OR (company_id = 3)))) WITH CHECK (((CURRENT_USER = SESSION_USER) AND (role = 'super_admin'::text) AND (system_role = 'super_admin'::text) AND (status = 'active'::text) AND (is_active IS TRUE) AND ((company_id IS NULL) OR (company_id = 3))));
CREATE POLICY cst_invoice_b2_read_cst ON public.users AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role = 'super_admin'::text) AND (system_role = 'super_admin'::text) AND (status = 'active'::text) AND (is_active IS TRUE) AND ((company_id IS NULL) OR (company_id = 1))));
CREATE POLICY cst_invoice_b2_read_diva ON public.users AS PERMISSIVE FOR SELECT TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role = 'super_admin'::text) AND (system_role = 'super_admin'::text) AND (status = 'active'::text) AND (is_active IS TRUE) AND ((company_id IS NULL) OR (company_id = 3))));
CREATE POLICY cst_invoice_b3_ownerlock_cst ON public.users AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_cst_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role = 'super_admin'::text) AND (system_role = 'super_admin'::text) AND (status = 'active'::text) AND (is_active IS TRUE) AND ((company_id IS NULL) OR (company_id = 1)))) WITH CHECK (false);
CREATE POLICY cst_invoice_b3_ownerlock_diva ON public.users AS PERMISSIVE FOR UPDATE TO bizportal_customer_invoice_diva_writer_dev USING (((CURRENT_USER = SESSION_USER) AND (role = 'super_admin'::text) AND (system_role = 'super_admin'::text) AND (status = 'active'::text) AND (is_active IS TRUE) AND ((company_id IS NULL) OR (company_id = 3)))) WITH CHECK (false);
SELECT 'DISPOSABLE_REAL_CSTDEV_INVOICE_RLS_PARITY_122' AS qa;
