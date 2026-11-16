-- PR105 disposable-only: genuine separate login roles; synthetic credentials.
-- NEVER execute on CST-DEV or PROD. Container is --network none.
CREATE ROLE ci_pr105_cst_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS
  PASSWORD 'synthetic-cst-only';
CREATE ROLE ci_pr105_diva_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS
  PASSWORD 'synthetic-diva-only';
CREATE ROLE ci_pr105_lock_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE TABLE public.ci_pr105_login_po (
 id integer PRIMARY KEY, company_id integer NOT NULL,
 vendor_token text NOT NULL, status text NOT NULL
);
INSERT INTO public.ci_pr105_login_po VALUES
 (11,1,'synthetic-cst-token','confirmed'),
 (31,3,'synthetic-diva-token','confirmed');
ALTER TABLE public.ci_pr105_login_po ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO ci_pr105_cst_login,ci_pr105_diva_login,ci_pr105_lock_owner;
GRANT SELECT ON public.ci_pr105_login_po TO ci_pr105_cst_login,ci_pr105_diva_login,ci_pr105_lock_owner;
GRANT UPDATE(status) ON public.ci_pr105_login_po TO ci_pr105_lock_owner;
CREATE POLICY ci_login_read ON public.ci_pr105_login_po
 FOR SELECT TO ci_pr105_cst_login,ci_pr105_diva_login
 USING ((current_user='ci_pr105_cst_login' AND company_id=1)
     OR (current_user='ci_pr105_diva_login' AND company_id=3));
-- The SECURITY DEFINER executes with current_user = ci_pr105_lock_owner;
-- session_user remains the actual authenticated LOGIN identity.
CREATE POLICY ci_owner_read ON public.ci_pr105_login_po
 FOR SELECT TO ci_pr105_lock_owner
 USING ((session_user='ci_pr105_cst_login' AND company_id=1)
     OR (session_user='ci_pr105_diva_login' AND company_id=3));
CREATE POLICY ci_owner_lock ON public.ci_pr105_login_po
 FOR UPDATE TO ci_pr105_lock_owner
 USING ((session_user='ci_pr105_cst_login' AND company_id=1)
     OR (session_user='ci_pr105_diva_login' AND company_id=3))
 WITH CHECK ((session_user='ci_pr105_cst_login' AND company_id=1)
     OR (session_user='ci_pr105_diva_login' AND company_id=3));
CREATE SCHEMA ci_pr105_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA ci_pr105_private FROM PUBLIC;
GRANT USAGE ON SCHEMA ci_pr105_private TO
  ci_pr105_cst_login,ci_pr105_diva_login,ci_pr105_lock_owner;
GRANT CREATE ON SCHEMA ci_pr105_private TO ci_pr105_lock_owner;
CREATE FUNCTION ci_pr105_private.lock_vendor_parent(p_po_id integer,p_token text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
  IF session_user NOT IN ('ci_pr105_cst_login','ci_pr105_diva_login')
    OR p_po_id IS NULL OR p_token IS NULL
  THEN RETURN FALSE; END IF;
  PERFORM 1 FROM public.ci_pr105_login_po p
    WHERE p.id=p_po_id AND p.vendor_token=p_token FOR UPDATE;
  RETURN FOUND;
END
$body$;
REVOKE ALL ON FUNCTION ci_pr105_private.lock_vendor_parent(integer,text) FROM PUBLIC;
ALTER FUNCTION ci_pr105_private.lock_vendor_parent(integer,text)
 OWNER TO ci_pr105_lock_owner;
REVOKE CREATE ON SCHEMA ci_pr105_private FROM ci_pr105_lock_owner;
GRANT EXECUTE ON FUNCTION ci_pr105_private.lock_vendor_parent(integer,text)
 TO ci_pr105_cst_login,ci_pr105_diva_login;
