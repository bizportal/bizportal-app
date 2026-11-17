/** Cleanup of one reviewed synthetic run only. This is not Finance acceptance.
 * Uses the existing DEV administrator connection solely for owned QA cleanup.
 * Company roles are inspected in catalogues; their credentials are never read
 * and no company connection, GCP secret lookup, or vendor request is attempted. */
async function cleanupOnlyRecoveryPreflight() {
  stage = "cleanup_only_admin_preflight";
  configureFromVerifiedServices(); // Preserve exact DEV target, storage and runtime gates.
  // Remove company credential discovery from this short-lived process only.
  delete process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED;
  delete process.env.CREDENTIALS_DIRECTORY;
  requireThat(process.env.SUPABASE_DATABASE_URL_DEV, "CLEANUP_ADMIN_DSN_REQUIRED");
  app = await import("../../lib/db/src/index");
  admin = await app.pool.connect();
  const identity = (await admin.query(`select current_user::text usr,session_user::text login,
    current_database() db,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) tls`)).rows[0];
  const clientTls = (admin as PoolClient & {
    connection?: { stream?: { encrypted?: boolean; authorized?: boolean } };
  }).connection?.stream;
  // The pooler's backend TLS differs from this client's TLS. Always require
  // the actual client to have verified its server certificate and hostname.
  requireThat(identity.usr === "postgres" && identity.login === "postgres" &&
    identity.db === "postgres" && clientTls?.encrypted === true && clientTls.authorized === true &&
    (!adminConnectsDirectly || identity.tls === true), "CLEANUP_ADMIN_SESSION_IDENTITY_OR_TLS");
  passed("CLEANUP_ONLY_ADMIN_IDENTITY_AND_CLIENT_TLS_VERIFIED", {
    connection: adminConnectsDirectly ? "direct" : "pooler", backendTls: identity.tls === true,
  });
  const lock = (await admin.query(`select md5(prosrc) fingerprint,prosecdef,
    pg_get_userbyid(proowner) owner,proconfig from pg_proc
    where oid=to_regprocedure('finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)')`)).rows[0];
  requireThat(lock?.fingerprint === "f74ae1995c4ec52505b06624c6010950" && lock.prosecdef === true &&
    lock.owner === "bizportal_finance_parent_lock_owner_dev" &&
    lock.proconfig?.includes("search_path=pg_catalog, pg_temp"), "CLEANUP_LOCK_FUNCTION_DRIFT");
  const triggers = await admin.query(`select count(*)::int n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal and c.relname=any($1::text[])`, [PARENT_TABLES]);
  requireThat(triggers.rows[0].n === 0, "NEW_PARENT_OR_FINANCE_TRIGGER_REQUIRES_REVIEW");
  const bucket = (await admin.query("select public from storage.buckets where id='private-uploads'")).rows[0];
  requireThat(bucket?.public === false, "PRIVATE_STORAGE_BUCKET");
  baselinePo14 = await po14Fingerprint();
  const baseline = baselinePo14 as { invoices: number; ap: number; handoffs: number };
  requireThat(baseline.invoices === 0 && baseline.ap === 0 && baseline.handoffs === 0, "PO14_BASELINE_NOT_ZERO");
  await recoveryProtectedPoUnchanged();

  const expectedRoles = ["bizportal_finance_cst_login_dev", "bizportal_finance_diva_login_dev"];
  const roles = (await admin.query(`select r.rolname,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolbypassrls,
      r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolconnlimit,
      (select count(*)::int from pg_auth_members m where m.member=r.oid) memberships,
      has_any_column_privilege(r.oid,'public.accounting_entries','INSERT') gl_write,
      has_any_column_privilege(r.oid,'public.payments','INSERT') payment_write,
      has_function_privilege(r.oid,
        'finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(integer,integer,integer,text)',
        'EXECUTE') parent_lock_execute
    from pg_roles r where r.rolname=any($1::text[]) order by r.rolname`, [expectedRoles])).rows;
  requireThat(roles.length === 2 && roles.every((row, index) => row.rolname === expectedRoles[index] &&
    row.rolcanlogin === true && row.rolinherit === false && row.rolsuper === false && row.rolbypassrls === false &&
    row.rolcreatedb === false && row.rolcreaterole === false && row.rolreplication === false &&
    row.rolconnlimit === 4 && row.memberships === 0 && row.gl_write === false && row.payment_write === false &&
    row.parent_lock_execute === true), "CLEANUP_COMPANY_ROLE_CATALOGUE_DRIFT");
  passed("CLEANUP_ONLY_ADMIN_RUNTIME_AND_CATALOGUE_VERIFIED", {
    scope: "owned synthetic fixtures only", companyRoleEvidence: "catalogue only",
    companyConnectivity: "NOT_TESTED", financeReadiness: "NOT_TESTED",
  });
}
