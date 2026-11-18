-- Disposable QA only, builds on Phase B1 fixture before applying Phase B2.
ALTER TABLE public.sales_documents ADD COLUMN customer_id integer;
UPDATE public.sales_documents SET customer_id=CASE WHEN company_id=1 THEN 20 ELSE 30 END;
CREATE TABLE public.users (
 id text PRIMARY KEY,email text,role text,system_role text,status text,
 is_active bool,company_id integer,password_hash text
);
INSERT INTO public.users VALUES
 ('global-admin','global@qa.invalid','super_admin','super_admin','active',true,NULL,'DO_NOT_DISCLOSE'),
 ('cst-admin','cst@qa.invalid','super_admin','super_admin','active',true,1,'DO_NOT_DISCLOSE'),
 ('diva-admin','diva@qa.invalid','super_admin','super_admin','active',true,3,'DO_NOT_DISCLOSE'),
 ('inactive-admin','inactive@qa.invalid','super_admin','super_admin','inactive',false,NULL,'DO_NOT_DISCLOSE');
CREATE TABLE public.portal_customers (
 id integer PRIMARY KEY,role text,account_status text,password_hash text
);
INSERT INTO public.portal_customers VALUES
 (10,'admin','active','DO_NOT_DISCLOSE'),
 (11,'admin','active','DO_NOT_DISCLOSE'),
 (20,'customer','active','DO_NOT_DISCLOSE'),
 (30,'customer','active','DO_NOT_DISCLOSE'),
 (40,'customer','active','DO_NOT_DISCLOSE'),
 (50,'admin','suspended','DO_NOT_DISCLOSE');
CREATE TABLE public.portal_company_members (
 id integer PRIMARY KEY,portal_customer_id integer,company_id integer,is_active boolean
);
INSERT INTO public.portal_company_members VALUES
 (1,10,1,true),(3,10,3,true),(4,10,1,false),(5,20,1,true),(6,30,3,true);
CREATE TABLE public.portal_company_requests (
 id integer PRIMARY KEY,portal_customer_id integer,matched_company_id integer,
 status text,reviewed_by integer,reviewed_at timestamptz
);
INSERT INTO public.portal_company_requests VALUES
 (1,10,1,'approved',11,now()),
 (3,10,3,'approved',11,now()),
 (4,10,1,'pending',NULL,NULL),
 (5,10,1,'approved',10,now()),
 (6,20,1,'approved',11,now()),
 (7,10,3,'rejected',11,now());
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_company_requests ENABLE ROW LEVEL SECURITY;
