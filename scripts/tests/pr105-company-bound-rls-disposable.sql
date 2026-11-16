-- PR105: SYNTHETIC ROLE-BOUND TENANT RLS, NO LIVE DB / NO REAL CREDENTIALS.
-- Disposable PG16/17 only. All DDL/DML uses BEGIN...ROLLBACK.
BEGIN;
CREATE ROLE ci_pr105_cst NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE ci_pr105_diva NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT ci_pr105_cst,ci_pr105_diva TO postgres WITH SET TRUE;
CREATE TABLE public.ci_pr105_po(id integer PRIMARY KEY,company_id integer NOT NULL,vendor_token text NOT NULL);
CREATE TABLE public.ci_pr105_shipments(id integer PRIMARY KEY,po_id integer NOT NULL,shipment_status text NOT NULL);
CREATE TABLE public.ci_pr105_receipts(id integer PRIMARY KEY,shipment_id integer NOT NULL,inspection_status text NOT NULL);
CREATE TABLE public.ci_pr105_invoice(id integer PRIMARY KEY,company_id integer NOT NULL,po_id integer NOT NULL,ref text NOT NULL);
INSERT INTO public.ci_pr105_po VALUES (11,1,'synthetic-cst-token'),(31,3,'synthetic-diva-token');
INSERT INTO public.ci_pr105_shipments VALUES(12,11,'delivered'),(32,31,'delivered');
INSERT INTO public.ci_pr105_receipts VALUES(13,12,'passed'),(33,32,'passed');
INSERT INTO public.ci_pr105_invoice VALUES(14,1,11,'SYN-CST'),(34,3,31,'SYN-DIVA');
ALTER TABLE public.ci_pr105_po ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_pr105_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_pr105_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ci_pr105_invoice ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO ci_pr105_cst,ci_pr105_diva;
GRANT SELECT ON public.ci_pr105_po,public.ci_pr105_shipments,public.ci_pr105_receipts,public.ci_pr105_invoice
 TO ci_pr105_cst,ci_pr105_diva;
GRANT INSERT ON public.ci_pr105_invoice TO ci_pr105_cst,ci_pr105_diva;

-- Simulate the old over-broad GUC-permissive policy, which could be retained
-- during a migration. It must NOT be able to override a restrictive role guard.
CREATE POLICY po_legacy_guc ON public.ci_pr105_po
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva
 USING(company_id=nullif(current_setting('app.marketplace_company_id',true),'')::integer);
CREATE POLICY po_allow_select ON public.ci_pr105_po
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva USING(true);
CREATE POLICY po_role_guard ON public.ci_pr105_po AS RESTRICTIVE
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva
 USING((current_user='ci_pr105_cst' AND company_id=1) OR
       (current_user='ci_pr105_diva' AND company_id=3));

CREATE POLICY shipments_allow_select ON public.ci_pr105_shipments
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva USING(true);
CREATE POLICY shipments_role_guard ON public.ci_pr105_shipments AS RESTRICTIVE
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva
 USING(EXISTS(SELECT 1 FROM public.ci_pr105_po p WHERE p.id=po_id));

CREATE POLICY receipts_allow_select ON public.ci_pr105_receipts
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva USING(true);
CREATE POLICY receipts_role_guard ON public.ci_pr105_receipts AS RESTRICTIVE
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva
 USING(EXISTS(SELECT 1 FROM public.ci_pr105_shipments sh WHERE sh.id=shipment_id));

CREATE POLICY invoice_allow_select ON public.ci_pr105_invoice
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva USING(true);
CREATE POLICY invoice_role_guard ON public.ci_pr105_invoice AS RESTRICTIVE
 FOR SELECT TO ci_pr105_cst,ci_pr105_diva
 USING(((current_user='ci_pr105_cst' AND company_id=1) OR
        (current_user='ci_pr105_diva' AND company_id=3)) AND
       EXISTS(SELECT 1 FROM public.ci_pr105_po p WHERE p.id=po_id AND p.company_id=public.ci_pr105_invoice.company_id));
CREATE POLICY invoice_allow_insert ON public.ci_pr105_invoice
 FOR INSERT TO ci_pr105_cst,ci_pr105_diva WITH CHECK(true);
CREATE POLICY invoice_guard_insert ON public.ci_pr105_invoice AS RESTRICTIVE
 FOR INSERT TO ci_pr105_cst,ci_pr105_diva
 WITH CHECK(((current_user='ci_pr105_cst' AND company_id=1) OR
             (current_user='ci_pr105_diva' AND company_id=3)) AND
             EXISTS(SELECT 1 FROM public.ci_pr105_po p WHERE p.id=po_id AND p.company_id=public.ci_pr105_invoice.company_id));

DO $verify$
BEGIN
 IF (SELECT rolcanlogin OR rolsuper OR rolbypassrls FROM pg_roles WHERE rolname='ci_pr105_cst') IS DISTINCT FROM false
 OR (SELECT rolcanlogin OR rolsuper OR rolbypassrls FROM pg_roles WHERE rolname='ci_pr105_diva') IS DISTINCT FROM false
 OR pg_has_role('ci_pr105_cst','ci_pr105_diva','MEMBER')
 OR pg_has_role('ci_pr105_diva','ci_pr105_cst','MEMBER')
 THEN RAISE EXCEPTION 'CI_ROLE_INTEGRITY_FAILED'; END IF;
END $verify$;

SET LOCAL ROLE ci_pr105_cst;
SELECT set_config('app.marketplace_company_id','3',true);
DO $verify$ BEGIN
 IF current_user <> 'ci_pr105_cst'
 OR (SELECT count(*) FROM public.ci_pr105_po)<>1
 OR NOT EXISTS(SELECT 1 FROM public.ci_pr105_po WHERE id=11 AND company_id=1)
 OR EXISTS(SELECT 1 FROM public.ci_pr105_po WHERE id=31)
 OR (SELECT count(*) FROM public.ci_pr105_shipments)<>1
 OR (SELECT count(*) FROM public.ci_pr105_receipts)<>1
 OR (SELECT count(*) FROM public.ci_pr105_invoice)<>1
 THEN RAISE EXCEPTION 'CI_CST_SCOPE_GUC_SPOOFING_NOT_DENIED'; END IF;
END $verify$;
SELECT 'CST_ROLE_BINDING_IGNORES_GUC_OVERRIDE_PASS';
INSERT INTO public.ci_pr105_invoice VALUES (15,1,11,'SYN-CST-CREATED');
DO $verify$ DECLARE blocked boolean:=false; BEGIN
 BEGIN INSERT INTO public.ci_pr105_invoice VALUES(35,3,31,'SYN-DIVA-DENIED');
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CI_CST_CROSS_COMPANY_INSERT_WAS_NOT_DENIED'; END IF;
END $verify$;
SELECT 'CST_CROSS_TENANT_WRITE_DENIED_PASS';
RESET ROLE;
SET LOCAL ROLE ci_pr105_diva;
SELECT set_config('app.marketplace_company_id','1',true);
DO $verify$ BEGIN
 IF current_user <> 'ci_pr105_diva'
 OR (SELECT count(*) FROM public.ci_pr105_po)<>1
 OR NOT EXISTS(SELECT 1 FROM public.ci_pr105_po WHERE id=31 AND company_id=3)
 OR EXISTS(SELECT 1 FROM public.ci_pr105_po WHERE id=11)
 OR (SELECT count(*) FROM public.ci_pr105_shipments)<>1
 OR (SELECT count(*) FROM public.ci_pr105_receipts)<>1
 OR (SELECT count(*) FROM public.ci_pr105_invoice)<>1
 THEN RAISE EXCEPTION 'CI_DIVA_SCOPE_GUC_SPOOFING_NOT_DENIED'; END IF;
END $verify$;
SELECT 'DIVA_ROLE_BINDING_IGNORES_GUC_OVERRIDE_PASS';
INSERT INTO public.ci_pr105_invoice VALUES(36,3,31,'SYN-DIVA-CREATED');
DO $verify$ DECLARE blocked boolean:=false; BEGIN
 BEGIN INSERT INTO public.ci_pr105_invoice VALUES(16,1,11,'SYN-CST-DENIED');
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CI_DIVA_CROSS_COMPANY_INSERT_WAS_NOT_DENIED'; END IF;
END $verify$;
SELECT 'DIVA_CROSS_TENANT_WRITE_DENIED_PASS';
RESET ROLE;
ROLLBACK;
SELECT CASE WHEN to_regclass('public.ci_pr105_po') IS NULL
 AND to_regclass('public.ci_pr105_shipments') IS NULL
 AND to_regclass('public.ci_pr105_receipts') IS NULL
 AND to_regclass('public.ci_pr105_invoice') IS NULL
 AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('ci_pr105_cst','ci_pr105_diva'))
 THEN 'PR105_COMPANY_BOUND_RLS_SYNTHETIC_ROLLBACK_PASS'
 ELSE 'PR105_CLEANUP_FAILED' END;
