-- Strictly disposable QA-only additions; never execute outside invoice_synthetic.
DO $guard$ BEGIN
 IF current_database()<>'invoice_synthetic' THEN RAISE EXCEPTION 'DISPOSABLE_ONLY'; END IF;
END $guard$;
CREATE TABLE IF NOT EXISTS public.users(
 id text PRIMARY KEY,
 email text NOT NULL,
 role text NOT NULL,
 system_role text,
 status text NOT NULL DEFAULT 'active',
 is_active boolean NOT NULL DEFAULT true,
 company_id integer
);
INSERT INTO public.users(id,email,role,system_role,status,is_active,company_id)
VALUES ('synthetic-owner','qa-invoice@example.invalid','super_admin','super_admin','active',true,null);
CREATE TABLE IF NOT EXISTS public.audit_accounting_events(
 id bigserial PRIMARY KEY,
 journal_id integer NOT NULL,
 action text NOT NULL,
 company_id integer NOT NULL,
 amount numeric,
 user_id text,
 actor_type text,
 correlation_id text,
 change_reason text,
 after_state jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.activity_logs(
 id bigserial PRIMARY KEY,
 actor_type text,actor_id text,actor_name text,
 action text,old_value jsonb,new_value jsonb,
 description text,deduplication_key text
);
CREATE UNIQUE INDEX IF NOT EXISTS activity_logs_dedup_qa
 ON public.activity_logs(deduplication_key)
 WHERE deduplication_key IS NOT NULL;
INSERT INTO public.sales_documents(
 id,doc_number,kind,status,invoice_status,payment_status,
 customer_name,total_amount,tax_amount,grand_total,
 company_id,invoice_number,invoice_date,due_date,tax_treatment,tax_rate_id
) VALUES (
 197,'QA-ORDER-197','order','confirmed','to_invoice','unpaid',
 'Synthetic Portal HTTP Invoice',100,0,100,1,null,null,null,'none',null
);
INSERT INTO public.sales_document_lines(document_id,name,quantity,unit_price,subtotal)
VALUES(197,'QA Portal service',1,100,100);
INSERT INTO public.sales_documents(
 id,doc_number,kind,status,invoice_status,payment_status,
 customer_name,total_amount,tax_amount,grand_total,
 company_id,invoice_number,invoice_date,due_date,tax_treatment,tax_rate_id
) VALUES (
 199,'QA-ORDER-199','order','confirmed','to_invoice','unpaid',
 'Synthetic Portal unauthorized replay',100,0,100,1,null,null,null,'none',null
);
INSERT INTO public.sales_document_lines(document_id,name,quantity,unit_price,subtotal)
VALUES(199,'QA Portal denied case',1,100,100);
