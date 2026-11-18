-- CST-DEV ONLY / phase A — dormant Customer Invoice writer identities.
-- Safety intent: register dedicated principals without allowing connections
-- or changing any existing Finance, Portal, Payroll, Fleet policy or grant.
DO $staging$
DECLARE
  role_to_create text;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ROLE_STAGING_WRONG_DATABASE_ACTOR';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN (
      'bizportal_customer_invoice_cst_writer_dev',
      'bizportal_customer_invoice_diva_writer_dev'
    )
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_INVOICE_DEV_ROLE_NAME_ALREADY_EXISTS';
  END IF;
  FOREACH role_to_create IN ARRAY ARRAY[
    'bizportal_customer_invoice_cst_writer_dev',
    'bizportal_customer_invoice_diva_writer_dev'
  ]
  LOOP
    EXECUTE format(
      'CREATE ROLE %I NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
      role_to_create
    );
  END LOOP;
END
$staging$;

COMMENT ON ROLE bizportal_customer_invoice_cst_writer_dev
  IS 'CST-DEV Invoice only: Phase A dormant NOLOGIN. No grants or secrets; tracked by BizPortal issue 149.';
COMMENT ON ROLE bizportal_customer_invoice_diva_writer_dev
  IS 'CST-DEV Invoice only: Phase A dormant NOLOGIN. No grants or secrets; tracked by BizPortal issue 149.';
