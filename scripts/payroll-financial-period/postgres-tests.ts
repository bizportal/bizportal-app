 // Reuses only the disposable runner and setup; no authenticated HTTP or live login.
 const {registerPayrollFinancialPeriod}=await import('./payroll-financial-period');
 const fs=await import('node:fs');
 let setupPool:Pool|undefined;
 const envBefore={APP_ENV:process.env.APP_ENV,PAYROLL_DEV_FINANCIAL_SETUP_ENABLED:process.env.PAYROLL_DEV_FINANCIAL_SETUP_ENABLED,
 BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV:process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV,BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV:process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV};
 try {
  process.env.APP_ENV='development';process.env.PAYROLL_DEV_FINANCIAL_SETUP_ENABLED='true';
  process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV='synthetic-period-admin';
  process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV='admin@example.test';
  await reset();
  await admin.query(`ALTER TABLE financial_periods ADD COLUMN id serial PRIMARY KEY,
    ADD COLUMN closed_at timestamp,ADD COLUMN closed_by text,ADD COLUMN period_close_signature text,
    ADD COLUMN close_reason text,ADD COLUMN created_at timestamp NOT NULL DEFAULT now(),
    ALTER COLUMN is_closed SET DEFAULT false,ALTER COLUMN override_allowed SET DEFAULT false,
    ALTER COLUMN is_closed SET NOT NULL,ALTER COLUMN override_allowed SET NOT NULL,
    ADD UNIQUE(company_id,month,year),ADD CHECK(month BETWEEN 1 AND 12);
   CREATE TABLE accounting_period_locks(id serial PRIMARY KEY,company_id integer,year integer,month integer,status text);
   CREATE TABLE payroll_financial_setup_events(id bigserial PRIMARY KEY,company_id integer NOT NULL,
    run_id integer NOT NULL REFERENCES payroll_runs(id),action text NOT NULL CHECK(action IN ('period_registered','funding_approved')),
    period_id integer NOT NULL REFERENCES financial_periods(id),bank_account_id integer,source_version text,
    request_id uuid NOT NULL,actor_id text NOT NULL CHECK(length(btrim(actor_id))>0),
    actor_email text NOT NULL CHECK(actor_email='admin@example.test'),
    note text NOT NULL CHECK(length(btrim(note)) BETWEEN 10 AND 500),evidence_reference text,
    occurred_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,request_id),
    CHECK((action='period_registered' AND bank_account_id IS NULL AND source_version IS NULL AND evidence_reference IS NULL)
     OR(action='funding_approved' AND bank_account_id IS NOT NULL AND source_version IS NOT NULL AND evidence_reference IS NOT NULL)));
   CREATE ROLE bizportal_payroll_dev LOGIN PASSWORD 'period-fixture-only' NOSUPERUSER NOBYPASSRLS NOINHERIT;
   GRANT USAGE ON SCHEMA public TO bizportal_payroll_dev;
   GRANT SELECT ON payroll_runs,financial_periods,accounting_period_locks,payroll_financial_setup_events TO bizportal_payroll_dev;
   GRANT UPDATE(status) ON payroll_runs TO bizportal_payroll_dev;
   GRANT INSERT(company_id,month,year) ON financial_periods TO bizportal_payroll_dev;
   GRANT INSERT(company_id,run_id,action,period_id,request_id,actor_id,actor_email,note) ON payroll_financial_setup_events TO bizportal_payroll_dev;
   GRANT USAGE,SELECT ON SEQUENCE financial_periods_id_seq,payroll_financial_setup_events_id_seq TO bizportal_payroll_dev;
   CREATE POLICY period_fixture_run_read ON payroll_runs FOR SELECT TO bizportal_payroll_dev USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
   CREATE POLICY period_fixture_run_lock ON payroll_runs FOR UPDATE TO bizportal_payroll_dev USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
   CREATE POLICY payroll_dev_company_scoped_read_v1 ON financial_periods FOR SELECT TO bizportal_payroll_dev USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
   CREATE POLICY payroll_setup_period_insert ON financial_periods FOR INSERT TO bizportal_payroll_dev WITH CHECK(
     company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer AND is_closed=false AND override_allowed=false AND closed_at IS NULL AND closed_by IS NULL
     AND current_setting('app.payroll_setup_actor_email',true)='admin@example.test'
     AND EXISTS(SELECT 1 FROM payroll_runs r WHERE r.id=NULLIF(current_setting('app.payroll_setup_run_id',true),'')::integer
      AND r.company_id=financial_periods.company_id AND r.month=financial_periods.month AND r.year=financial_periods.year
      AND r.status IN('draft','reviewed') AND r.posting_status='pending' AND r.accounting_entry_id IS NULL AND r.payment_entry_id IS NULL)
     AND NOT EXISTS(SELECT 1 FROM accounting_period_locks l WHERE l.company_id=financial_periods.company_id AND l.month=financial_periods.month AND l.year=financial_periods.year AND l.status IS DISTINCT FROM 'unlocked'));
   ALTER TABLE accounting_period_locks ENABLE ROW LEVEL SECURITY;
   CREATE POLICY period_fixture_lock_read ON accounting_period_locks FOR SELECT TO bizportal_payroll_dev USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
   ALTER TABLE payroll_financial_setup_events ENABLE ROW LEVEL SECURITY;
   CREATE POLICY payroll_setup_scoped_read ON payroll_financial_setup_events FOR SELECT TO bizportal_payroll_dev USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
   CREATE POLICY payroll_setup_scoped_insert ON payroll_financial_setup_events FOR INSERT TO bizportal_payroll_dev WITH CHECK(
    company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer AND run_id=NULLIF(current_setting('app.payroll_setup_run_id',true),'')::integer
    AND actor_id=current_setting('app.payroll_setup_actor_id',true) AND actor_email=current_setting('app.payroll_setup_actor_email',true)
    AND request_id=NULLIF(current_setting('app.payroll_setup_request_id',true),'')::uuid AND note=current_setting('app.payroll_setup_note',true));`);
  await admin.query(fs.readFileSync('__ROOT__/scripts/payroll-financial-period/dev-audit-trigger-snapshot.sql','utf8'));
  const observed=(await admin.query("SELECT proname,md5(pg_get_functiondef(oid)) AS hash FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])",[['payroll_financial_period_insert_audit','payroll_financial_setup_event_guard']])).rows;
  const expected:Record<string,string>={payroll_financial_period_insert_audit:'1b9b3b853ebc81601ffa56029590d57d',payroll_financial_setup_event_guard:'39a7f157205ce829de71aeee5d5a90c0'};
  assert.equal(observed.length,2);for(const row of observed)assert.equal(row.hash,expected[row.proname],row.proname+' must match inspected live definition');
  ok('two unchanged audit trigger definitions match actual CST-DEV hashes');
  await admin.query(`CREATE TRIGGER payroll_financial_period_audit AFTER INSERT ON financial_periods FOR EACH ROW EXECUTE FUNCTION payroll_financial_period_insert_audit();
   CREATE TRIGGER payroll_financial_setup_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_financial_setup_events FOR EACH ROW EXECUTE FUNCTION payroll_financial_setup_event_guard();
   CREATE TRIGGER payroll_financial_setup_no_truncate BEFORE TRUNCATE ON payroll_financial_setup_events FOR EACH STATEMENT EXECUTE FUNCTION payroll_financial_setup_event_guard();`);
  const setupUrl=new URL(process.env.PAYROLL_PG_E2E_URL!);setupUrl.username='bizportal_payroll_dev';setupUrl.password='period-fixture-only';
  setupPool=new Pool({connectionString:setupUrl.href,max:4});
  const request={companyId:1,runId:32,requestId:'d769a067-dd14-4d9e-ae3c-54e7aedf7b68',note:'Synthetic isolated DEV period registration only',actor:{id:'synthetic-period-admin',email:'admin@example.test',role:'super_admin'}};
  let scenario=0, scenarioYear=2040, scenarioMonth=1;
  async function clean(){
   // Use a fresh synthetic run/period per case. All immutable audit triggers
   // remain installed throughout; no audit DELETE, TRUNCATE or disabling.
   scenario++;scenarioYear=2040+Math.floor((scenario-1)/12);scenarioMonth=1+(scenario-1)%12;
   request.runId=2000+scenario;request.requestId=(await import('node:crypto')).randomUUID();
   await admin.query("INSERT INTO payroll_runs(id,company_id,year,month,status,posting_status) VALUES($1,1,$2,$3,'draft','pending')",[request.runId,scenarioYear,scenarioMonth]);
  }
  const count=async()=>(await admin.query(`SELECT
   (SELECT count(*)::int FROM financial_periods WHERE company_id=1 AND year=$1 AND month=$2) AS periods,
   (SELECT count(*)::int FROM payroll_financial_setup_events WHERE company_id=1 AND run_id=$3) AS audit`,[scenarioYear,scenarioMonth,request.runId])).rows[0];
  const call=(mut:Partial<typeof request>={})=>registerPayrollFinancialPeriod(setupPool!,{...request,...mut});
  const financeBefore=await state();
  await clean();
  const result=await call();assert.equal(result.created,true);assert.equal(result.replayed,false);
  assert.deepEqual(await count(),{periods:1,audit:1});assert.equal(result.fundingApproved,false);assert.equal(result.salaryPaid,false);assert.equal(result.payrollApproved,false);
  const row=(await admin.query('SELECT * FROM payroll_financial_setup_events WHERE run_id=$1',[request.runId])).rows[0];
  assert.equal(row.action,'period_registered');assert.equal(row.actor_id,request.actor.id);assert.equal(row.request_id,request.requestId);
  assert.deepEqual(await state(),financeBefore);ok('real limited-role INSERT creates exactly one period and one trigger-generated audit, no finance changes');
  const again=await call();assert.equal(again.created,false);assert.equal(again.replayed,true);assert.equal(again.auditEventId,result.auditEventId);assert.deepEqual(await count(),{periods:1,audit:1});ok('same request replays recorded audit without another period or event');
  await assert.rejects(call({note:'Different payload with same request identifier'}),/AUDIT_MISSING_OR_CHANGED/);assert.deepEqual(await count(),{periods:1,audit:1});ok('idempotency key rejects changed payload');
  await clean();const pair=await Promise.all([call(),call()]);assert.equal(pair.filter(r=>r.created).length,1);assert.equal(pair.filter(r=>r.replayed).length,1);assert.deepEqual(await count(),{periods:1,audit:1});ok('concurrent same-request calls result in one registration and one replay');
  await clean();
  const independent=await Promise.all([call(),call({requestId:(await import('node:crypto')).randomUUID()})]);
  assert.equal(independent.filter(r=>r.created).length,1);assert.deepEqual(await count(),{periods:1,audit:1});
  ok('concurrent distinct requests do not create a duplicate period or audit');
  await clean();await admin.query('INSERT INTO financial_periods(company_id,month,year) VALUES(1,$1,$2)',[scenarioMonth,scenarioYear]);
  const existing=await call();assert.equal(existing.created,false);assert.equal(existing.auditEventId,null);assert.deepEqual(await count(),{periods:1,audit:0});ok('existing open period reused without manufacturing audit or human approval');
  await clean();await admin.query('INSERT INTO financial_periods(company_id,month,year,is_closed) VALUES(1,$1,$2,true)',[scenarioMonth,scenarioYear]);
  await assert.rejects(call(),/CLOSED_OR_OVERRIDE_PERIOD/);assert.equal((await count()).audit,0);ok('closed period is never reopened');
  await admin.query('UPDATE financial_periods SET override_allowed=true WHERE company_id=1 AND month=$1 AND year=$2',[scenarioMonth,scenarioYear]);await assert.rejects(call(),/CLOSED_OR_OVERRIDE_PERIOD/);ok('closed period override is not used as automatic permission');
  for(const status of ['locked',null,'unrecognized']){
   await clean();await admin.query('INSERT INTO accounting_period_locks(company_id,month,year,status) VALUES(1,$1,$2,$3)',[scenarioMonth,scenarioYear,status]);
   await assert.rejects(call(),/ACCOUNTING_PERIOD_LOCKED/);assert.deepEqual(await count(),{periods:0,audit:0});ok('external lock '+String(status)+' refuses period registration');
  }
  await clean();await assert.rejects(call({companyId:2}),/RUN_NOT_FOUND/);assert.deepEqual(await count(),{periods:0,audit:0});ok('foreign-company run denied without period/audit writes');
  await assert.rejects(call({actor:{...request.actor,id:'different-admin'}}),/VERIFIED_ACTOR_REQUIRED/);ok('unapproved actor pin refused before connecting');
  await assert.rejects(call({requestId:'invalid'}),/REQUEST_INVALID/);ok('invalid request ID rejected');
  await admin.query("UPDATE payroll_runs SET posting_status='posted',accounting_entry_id=99 WHERE id=$1",[request.runId]);await assert.rejects(call(),/RUN_NOT_ELIGIBLE/);assert.deepEqual(await count(),{periods:0,audit:0});ok('already posted payroll cannot register a new period');
  await clean();
  await admin.query(`CREATE FUNCTION ci_period_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_WRITE_FAILURE';END$$;
   CREATE TRIGGER ci_period_audit_failure BEFORE INSERT ON payroll_financial_setup_events FOR EACH ROW EXECUTE FUNCTION ci_period_audit_failure()`);
  try{await assert.rejects(call(),/REGISTRATION_FAILED/);assert.deepEqual(await count(),{periods:0,audit:0});ok('audit write failure rolls back period INSERT');}
  finally{await admin.query('DROP TRIGGER ci_period_audit_failure ON payroll_financial_setup_events;DROP FUNCTION ci_period_audit_failure()');}
  await admin.query(`CREATE FUNCTION ci_period_audit_suppress() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;
   CREATE TRIGGER ci_period_audit_suppress BEFORE INSERT ON payroll_financial_setup_events FOR EACH ROW EXECUTE FUNCTION ci_period_audit_suppress()`);
  try{await assert.rejects(call(),/AUDIT_MISSING_OR_CHANGED/);assert.deepEqual(await count(),{periods:0,audit:0});ok('silently absent audit detected by read-back and period rolled back');}
  finally{await admin.query('DROP TRIGGER ci_period_audit_suppress ON payroll_financial_setup_events;DROP FUNCTION ci_period_audit_suppress()');}
  const c=await setupPool.connect();
  try{
   const acl=(await c.query(`SELECT has_column_privilege(current_user,'financial_periods','is_closed','UPDATE') AS reopen,
    has_column_privilege(current_user,'financial_periods','override_allowed','UPDATE') AS override,
    has_table_privilege(current_user,'salary_payments','INSERT') AS pay,
    has_table_privilege(current_user,'payroll_financial_setup_events','UPDATE') AS change_audit`)).rows[0];
   assert.equal(Object.values(acl).some(Boolean),false);ok('limited database identity cannot reopen, override, pay, or mutate audit');
   const scope=(await c.query("SELECT nullif(current_setting('app.payroll_company_id',true),'') AS scope")).rows[0].scope;assert.equal(scope,null);ok('company/actor transaction context does not persist in pool');
  }finally{c.release();}
  const last=await call();
  const forged=await setupPool.connect();
  try{
   await forged.query('BEGIN');
   const fakeId=(await import('node:crypto')).randomUUID();
   await forged.query(`SELECT set_config('app.payroll_company_id','1',true),set_config('app.payroll_setup_run_id',$1,true),
    set_config('app.payroll_setup_request_id',$2,true),set_config('app.payroll_setup_actor_id',$3,true),
    set_config('app.payroll_setup_actor_email',$4,true),set_config('app.payroll_setup_note',$5,true)`,
    [String(request.runId),fakeId,request.actor.id,request.actor.email,request.note]);
   await assert.rejects(forged.query(`INSERT INTO payroll_financial_setup_events(company_id,run_id,action,period_id,request_id,actor_id,actor_email,note)
    VALUES(1,$1,'period_registered',$2,$3,$4,$5,$6)`,[request.runId,last.periodId,fakeId,request.actor.id,request.actor.email,request.note]),/PERIOD_AUDIT_REQUIRES_INSERT_TRIGGER/);
   await forged.query('ROLLBACK');ok('direct fabricated registration event is refused by unchanged audit nesting guard');
  }finally{forged.release();}
  await admin.query('UPDATE financial_periods SET is_closed=true WHERE id=$1',[last.periodId]);
  await assert.rejects(call(),/CLOSED_OR_OVERRIDE_PERIOD/);assert.deepEqual(await count(),{periods:1,audit:1});
  ok('replay after period closure is rejected without reopening the period');
  await assert.rejects(admin.query("UPDATE payroll_financial_setup_events SET note='attempt audit edit'"),/AUDIT_IMMUTABLE/);ok('original append-only audit guard still rejects edits');
  await assert.rejects(admin.query('TRUNCATE payroll_financial_setup_events'),/AUDIT_IMMUTABLE/);ok('original audit truncate guard stayed enabled and explicitly rejects truncation');
  assert.deepEqual(await state(),financeBefore);ok('Payroll/approval/journals/kasbon/bank-payment counts unchanged across setup tests');
  console.log('AUDITED_PERIOD_REGISTRATION_POSTGRES_PASS',passed,'LIVE_DATABASE_USED',false,'FUNDING_APPROVED',false);
 }finally{
  if(setupPool)await setupPool.end();
  for(const [k,v] of Object.entries(envBefore)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
}finally{if(writer)await writer.end();await admin.end();}
