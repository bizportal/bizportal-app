-- CST-DEV ONLY — rollback only while both Phase A roles remain dormant.
DO $rollback$
DECLARE r record;
BEGIN
 IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
   RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ROLE_ROLLBACK_WRONG_DATABASE_ACTOR';
 END IF;
 FOR r IN SELECT rolname, rolcanlogin, rolbypassrls, rolsuper FROM pg_roles
   WHERE rolname IN (
    'bizportal_customer_invoice_cst_writer_dev',
    'bizportal_customer_invoice_diva_writer_dev'
   )
 LOOP
   IF r.rolcanlogin OR r.rolbypassrls OR r.rolsuper THEN
     RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ROLE_NOT_DORMANT: %',r.rolname;
   END IF;
   -- Hosted PostgreSQL 17 CREATEROLE gives its creator (postgres)
   -- an automatic ADMIN membership, but no INHERIT or SET privilege.
   -- Only that exact management edge is acceptable for a dormant rollback.
   IF EXISTS (
     SELECT 1 FROM pg_auth_members m
     JOIN pg_roles member ON member.oid=m.member
     WHERE (m.roleid=(SELECT oid FROM pg_roles WHERE rolname=r.rolname)
        OR m.member=(SELECT oid FROM pg_roles WHERE rolname=r.rolname))
       AND NOT (
         m.roleid=(SELECT oid FROM pg_roles WHERE rolname=r.rolname)
         AND member.rolname='postgres'
         AND m.admin_option=true
         AND m.inherit_option=false
         AND m.set_option=false
       )
   ) THEN
     RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ROLE_UNEXPECTED_MEMBERSHIP: %',r.rolname;
   END IF;
 END LOOP;
 -- These will fail (without CASCADE) if any grant, policy or object depends
 -- on either role: never remove an activated or shared role implicitly.
 DROP ROLE IF EXISTS bizportal_customer_invoice_cst_writer_dev;
 DROP ROLE IF EXISTS bizportal_customer_invoice_diva_writer_dev;
END
$rollback$;
