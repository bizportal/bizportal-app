 // Integration is appended to the existing native package / restricted writer
 // fixture after its real financial schema, RLS, audit and outbox are installed.
 // Every role, session, row and transaction is synthetic and localhost-only.
 // Reuse the already-PASS least-privilege settlement fixture, including
 // restricted column grants and 18-table preflight. Never bypass that gate.
 await admin.query((await import('node:fs')).readFileSync(
   '__ROOT__/scripts/payroll-atomic-rehearsal/least-privilege-fixture.sql','utf8'));
 await admin.query((await import('node:fs')).readFileSync(
   '__ROOT__/scripts/payroll-calculate/integrated-native-fixture.sql','utf8'));
 // Verify the proposed CST-DEV 18-table settlement grant/policy contract on
 // the same disposable database before binding the actual HTTP preflight.
 // This source-only candidate does not grant anything on live CST-DEV.
 await admin.query((await import('node:fs')).readFileSync(
   '__ROOT__/scripts/payroll-calculate/cst-dev-settlement-18table-readiness.sql','utf8'));
 // Real email OTP handler creates and consumes records on this fixture DB,
 // not CST-DEV. The only stub is the external SMTP send; it captures the
 // actual randomly generated OTP for a subsequent real HTTP verification.
 await admin.query(`CREATE TABLE public.bizportal_email_otp_codes(
  id bigserial PRIMARY KEY,email text NOT NULL,request_ip text NOT NULL,
  purpose text NOT NULL,code_hash text,attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
 )`);
 // The actual DEV environment has an inactive legacy admin sharing the
 // pinned Super Admin email. Prove this sign-in selects the exact user ID.
 await admin.query("ALTER TABLE public.users DROP CONSTRAINT users_email_key");
 await admin.query(`INSERT INTO public.users(id,email,role,company_id,status,is_active)
 VALUES('synthetic-inactive-admin','admin@example.test','admin',NULL,'inactive',false)`);
 const calcUrl=new URL(process.env.PAYROLL_PG_E2E_URL!);
 calcUrl.username='bizportal_payroll_dev';calcUrl.password='fixture-calc-only-2026';
 const approveUrl=new URL(process.env.PAYROLL_PG_E2E_URL!);
 approveUrl.username='bizportal_payroll_approver_dev';approveUrl.password='fixture-approval-only-2026';
 const calcPool=new Pool({connectionString:calcUrl.href,max:2});
 const approvePool=new Pool({connectionString:approveUrl.href,max:1});
 (globalThis as any).__payrollIntegrated={admin,calculate:calcPool,approve:approvePool};
 const previousEnvKeys=['APP_ENV','NODE_ENV','SESSION_SECRET','BIZPORTAL_SESSION_SECRET',
 'BIZPORTAL_SIGNED_OTP_ENABLED_DEV','BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV',
 'BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV','BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV',
 'PAYROLL_DEV_CALCULATE_ENABLED','PAYROLL_DEV_CALCULATE_ALLOWED_ORIGIN',
 'PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED','PAYROLL_DEV_ATOMIC_POSTING_ENABLED',
 'PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED'] as const;
 const priorEnvs=Object.fromEntries(previousEnvKeys.map(key=>[key,process.env[key]]));
 process.env.APP_ENV='development';process.env.NODE_ENV='test';
 process.env.SESSION_SECRET='payroll-only-fixture-HMAC-secret-2026-not-live';
 delete process.env.BIZPORTAL_SESSION_SECRET;
 process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV='true';
 delete process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV;
 process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV='admin@example.test';
 process.env.BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV='synthetic-super-admin';
 process.env.PAYROLL_DEV_CALCULATE_ENABLED='true';
 process.env.PAYROLL_DEV_CALCULATE_ALLOWED_ORIGIN='http://127.0.0.1:19002';
 process.env.PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED='true';
 process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='true';
 process.env.PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED='true';
 const express=(await import('express')).default;
 const {Router}=await import('express');
 const {createServer}=await import('node:http');
 const {once}=await import('node:events');
 const auth=await import('__ROOT__/artifacts/api-server/src/routes/dev-auth.ts');
 const access=await import('__ROOT__/artifacts/api-server/src/routes/payroll-access.ts');
 const calcRoute=await import('__ROOT__/artifacts/api-server/src/routes/payroll-calculate-http.ts');
 const approvalRoute=await import('__ROOT__/artifacts/api-server/src/routes/payroll-super-admin-approval.ts');
 const postingRoute=await import('__ROOT__/artifacts/api-server/src/routes/payroll-accounting-http.ts');
 const otpRouter=(await import('__ROOT__/artifacts/api-server/src/routes/local-production-auth.ts')).default;
 // This is the actual production-source server binder and its real restricted
 // PostgreSQL read-only catalog preflight. No substitution is permitted here.
 const verifiedPostingGate=await postingRoute.bindDevPayrollAtomicHttpRuntime({
   pool:writer!,writer:patched.PayrollJournalService,
   allowedOrigin:'http://127.0.0.1:19002'
 });
 assert.equal(verifiedPostingGate,undefined);
 console.log('INTEGRATED_18_TABLE_PREFLIGHT_BOUND',true,'ACTUAL_HTTP_ROUTER',true);
 const app=express();app.use(express.json());
 app.use((req:any,res:any,next:any)=>{
   req.log={error(){},warn(){}};next();
 });
 app.use('/api',otpRouter);
 app.use('/api',calcRoute.createDevPayrollCalculateRouter());
 app.use('/api',postingRoute.createPayrollAtomicAccountingRouter());
 const scoped=Router();
 scoped.use(async(req:any,res:any,next:any)=>{
  try{
   const session=auth.getProductionSession(req);
   if(!session){res.status(401).json({code:'AUTH_REQUIRED'});return;}
   const actor=await auth.getProductionUser(session);
   if(!actor){res.status(401).json({code:'ACTIVE_ACTOR_NOT_FOUND'});return;}
   const company=access.authorizePayrollCompany(actor,req.query.companyId);
   if(!company){res.status(403).json({code:'COMPANY_DENIED'});return;}
   req.payrollActor=actor;req.payrollCompanyId=company;next();
  }catch{res.status(503).json({code:'SIGNED_AUTH_UNAVAILABLE'});}
 });
 approvalRoute.registerPayrollSuperAdminApprovalRoutes(scoped);
 app.use('/api',scoped);
 const server=createServer(app);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();if(!address||typeof address==='string')throw Error('NO_HTTP_LOOPBACK_ADDRESS');
 const rootUrl='http://127.0.0.1:'+address.port;
 const makeCookie=(id='synthetic-super-admin',email='admin@example.test')=>{
  let raw='';const fake={append:(header:string,value:string)=>{if(header==='Set-Cookie')raw=value;return fake;}};
  auth.setProductionSessionCookie(fake as any,{
   id,email,issuedAt:Date.now(),expiresAt:Date.now()+120000
  });
  return raw.split(';')[0];
 };
 let signedCookie='';
 const request=async(path:string,method='GET',body?:unknown,cookie=signedCookie)=>{
  const headers:Record<string,string>={Origin:'http://127.0.0.1:19002',cookie};
  if(method==='POST')headers['content-type']='application/json';
  return fetch(rootUrl+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
 };
 const calc=()=>request('/api/payroll/runs/32/calculate?companyId=1','POST',{});
 const preview=()=>request('/api/payroll/runs/32/super-admin-approval-preview?companyId=1');
 const approve=(digest:string)=>request('/api/payroll/runs/32/super-admin-approve?companyId=1','POST',{
   confirm:true,expectedDigest:digest,note:'Synthetic accounting integration Super Admin approval'
 });
 let integratedPass=0;
 const pass=(label:string)=>{integratedPass++;console.log('INTEGRATED_PASS',label);};
 const prepare=async()=>{
   await reset();
   await admin.query("DELETE FROM payroll_kasbon_auto_reservations WHERE run_id=32");
   // The inherited native suite's read-back is pinned to fixture hold 501.
   // Reset only this synthetic sequence between independent test cases.
   await admin.query("ALTER SEQUENCE public.ci_integrated_hold_seq RESTART WITH 501");
   // Existing immutable HR review guard forbids reopening reviewed->draft.
   // Replace only the disposable reset fixture row with a fresh Draft.
   await admin.query("DELETE FROM payroll_runs WHERE id=32");
   await admin.query("INSERT INTO payroll_runs(id,company_id,year,month,status,posting_status,approved_at,notes) VALUES(32,1,2026,11,'draft','pending',NULL,NULL)");
   await admin.query("UPDATE payroll_items SET kasbon_deduction=0,total_deductions=200000,net_salary=5000000 WHERE id=11");
   await admin.query("DELETE FROM payroll_kasbon_auto_plans");
   await admin.query("INSERT INTO payroll_kasbon_auto_plans (company_id,employee_id,advance_id,choice,installment_amount,first_period) VALUES(1,101,801,'INSTALLMENT',100000,'2026-11-01')");
   const r=await calc();assert.equal(r.status,200,'Calculate should return HTTP 200');const value=await r.json();
   assert.equal(value.status,'draft');assert.equal(value.preparedReservations,1);
   assert.equal(value.net,'4900000.00');assert.equal(value.accountingPosted,false);assert.equal(value.salaryPaid,false);
   const p=await preview();assert.equal(p.status,200,'Approval preview should return HTTP200');
   const ready=await p.json();assert.equal(ready.canApprove,true);assert.equal(ready.digest,value.digest);
   const result=await approve(value.digest);assert.equal(result.status,200,'One approval should return HTTP200');
   const approved=await result.json();assert.equal(approved.status,'reviewed');assert.equal(approved.oneSuperAdminApproval,true);
   return value.digest as string;
 };
 // Post through the real HTTP route, never call the transaction service
 // directly from the success/fault/replay test.
 const post=(digest:string)=>request('/api/payroll/runs/32/post-accounting?companyId=1','POST',{
   expectedDigest:digest,postingDate:'2026-11-17'
 });
 try{
  // The *real* email OTP send handler generates a random 6-digit code and
  // writes its bcrypt hash to disposable PostgreSQL. Only the actual SMTP
  // network send is replaced by an in-memory test mailbox.
  const otpSend=await request('/api/auth/email-otp/send','POST',{email:'admin@example.test'},'');
  assert.equal(otpSend.status,202,'Original OTP send handler must accept pinned Super Admin');
  const syntheticMail=(globalThis as any).__payrollIntegrated;
  assert.equal(syntheticMail.otpSendCount,1);
  const deliveredCode=syntheticMail.otpCode;
  assert.match(deliveredCode,/^[1-9][0-9]{5}$/);
  const storedOtp=await admin.query(`SELECT code_hash,verified_at,attempts
    FROM public.bizportal_email_otp_codes WHERE email='admin@example.test'`);
  assert.equal(storedOtp.rows.length,1);
  assert.ok(storedOtp.rows[0].code_hash);
  assert.equal(storedOtp.rows[0].verified_at,null);
  assert.equal(storedOtp.rows[0].attempts,0);
  assert.equal(JSON.stringify(storedOtp.rows).includes(deliveredCode),false);
  pass('real DEV email OTP send stores bcrypt hash; test SMTP captures code without external delivery');

  const wrong=await request('/api/auth/email-otp/verify','POST',{
   email:'admin@example.test',code:'000000'
  },'');
  assert.equal(wrong.status,400,'Incorrect actual OTP must be rejected');
  const verified=await request('/api/auth/email-otp/verify','POST',{
   email:'admin@example.test',code:deliveredCode
  },'');
  assert.equal(verified.status,200,'Original OTP verification must issue signed session');
  const verifiedBody=await verified.json();
  assert.equal(verifiedBody?.user?.id,'synthetic-super-admin');
  assert.equal(verifiedBody?.user?.role,'super_admin');
  const setCookie=verified.headers.get('set-cookie')??'';
  assert.match(setCookie,/bizportal_supabase_session=/);
  assert.match(setCookie,/HttpOnly/);
  assert.match(setCookie,/Secure/);
  signedCookie=setCookie.split(';')[0];
  const replayVerify=await request('/api/auth/email-otp/verify','POST',{
   email:'admin@example.test',code:deliveredCode
  },'');
  assert.equal(replayVerify.status,400,'Consumed one-time OTP must not be accepted again');
  const otpAfter=await admin.query(`SELECT verified_at IS NOT NULL AS consumed, attempts
   FROM public.bizportal_email_otp_codes WHERE email='admin@example.test'`);
  assert.equal(otpAfter.rows[0].consumed,true);
  assert.equal(otpAfter.rows[0].attempts,1);
  delete syntheticMail.otpCode;
  pass('wrong OTP denied; real verify creates pinned signed session and consumed OTP cannot replay');

  const digest=await prepare();
  const before=await state();
  assert.deepEqual(before,{entries:0,lines:0,audit:0,outbox:0,
   balance:'500000.00',reservation:'prepared',status:'reviewed',
   entry_id:null,payments:0,repayments:0});
  pass('one signed HTTP Calculate and approval persist a clean Reviewed run and prepared hold');
  await admin.query("UPDATE public.users SET is_active=false,status='inactive' WHERE id='synthetic-super-admin'");
  const revokedPost=await post(digest);
  assert.equal(revokedPost.status,403,'revoked OTP actor must be refused on every financial request');
  assert.deepEqual(await state(),before);
  await admin.query("UPDATE public.users SET is_active=true,status='active' WHERE id='synthetic-super-admin'");
  pass('original OTP cookie cannot post after Super Admin deactivation or change approved data');
  const postingPath='/api/payroll/runs/32/post-accounting?companyId=1';
  const postingBody={expectedDigest:digest,postingDate:'2026-11-17'};
  assert.equal((await request(postingPath,'POST',postingBody,'')).status,401);
  assert.equal((await request(postingPath,'POST',postingBody,makeCookie('synthetic-owner','owner@example.test'))).status,403);
  assert.equal((await request(postingPath,'POST',postingBody,makeCookie('synthetic-finance','finance@example.test'))).status,403);
  assert.deepEqual(await state(),before);
  pass('posting HTTP denies missing sessions, Owner and Finance without any financial mutation');
  const wrongOrigin=await fetch(rootUrl+postingPath,{
    method:'POST',headers:{Origin:'http://foreign.example.test',cookie:signedCookie,'content-type':'application/json'},
    body:JSON.stringify(postingBody)
  });
  assert.equal(wrongOrigin.status,403);
  assert.equal((await post('0'.repeat(64))).status,409);
  assert.deepEqual(await state(),before);
  pass('posting HTTP denies wrong Origin and approval digest before changing the ledger');
  process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='';
  assert.equal((await post(digest)).status,404);
  process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='true';
  assert.deepEqual(await state(),before);
  pass('posting runtime gate switched OFF still blocks financial writes');
  const postedHttp=await post(digest);
  assert.equal(postedHttp.status,200,'Actual posting endpoint must return HTTP200');
  const result=await postedHttp.json();
  assert.equal(result.reused,false);
  assert.equal(result.accountingPosted,true);
  assert.equal(result.salaryPaid,false);
  const after=await state();
  assert.deepEqual(after,{entries:1,lines:6,audit:1,outbox:1,
   balance:'400000.00',reservation:'confirmed',status:'approved',
   entry_id:result.entryId,payments:0,repayments:1});
  assert.equal(outsideQueries,0);
  const balanced=await admin.query('SELECT total_debit::text AS debit,total_credit::text AS credit FROM accounting_entries WHERE id=$1',[result.entryId]);
  assert.equal(balanced.rows[0].debit,balanced.rows[0].credit);
  pass('pinned native accrual atomically posts one balanced journal, audit, outbox and noncash kasbon repayment');
  const replayHttp=await post(digest);
  assert.equal(replayHttp.status,200,'Actual posting replay must be HTTP200');
  const replay=await replayHttp.json();
  assert.equal(replay.reused,true);
  assert.equal(replay.entryId,result.entryId);
  assert.deepEqual(await state(),after);
  pass('full workflow replay creates no extra journal, cash deduction, reservation or salary payout');
  assert.equal((await calc()).status,404,'Repeated Calculate must be blocked after posting');
  assert.equal((await approve(digest)).status,404,'Repeated Super Admin approval must be blocked');
  assert.equal((await request('/api/payroll/runs/33/calculate?companyId=1','POST',{})).status,404);
  const other=await admin.query('SELECT status FROM payroll_runs WHERE id=33');
  assert.equal(other.rows[0].status,'reviewed');
  pass('post-approval Calculate/approval replay and foreign company are rejected');

  // A valid Super Admin cannot use a different company selection to post the
  // previously approved company's run. Authorization never overrides SQL RLS.
  const foreignScope=await request('/api/payroll/runs/32/post-accounting?companyId=2','POST',{
   expectedDigest:digest,postingDate:'2026-11-17'
  });
  assert.equal(foreignScope.status,404,'cross-company posting must be invisible');
  assert.deepEqual(await state(),after);
  pass('posting HTTP refuses a wrong-company selection without any journal or kasbon change');

  // Failed post should preserve the single, signed approval receipt and hold
  // (rather than silently overriding a closed accounting period).
  const closedDigest=await prepare();
  const closedBefore=await state();
  await admin.query('UPDATE financial_periods SET is_closed=true WHERE company_id=1');
  const closedResponse=await post(closedDigest);
  assert.equal(closedResponse.status,409,'closed financial period must fail safely');
  assert.equal((await closedResponse.json()).code,'PAYROLL_INTEGRITY_BLOCKED');
  assert.deepEqual(await state(),closedBefore);
  pass('posting HTTP refuses closed financial period and leaves approved data intact');

  // Even a legitimate signed approval cannot be reused after a salary edit.
  const changedDigest=await prepare();
  await admin.query('UPDATE payroll_items SET base_salary=5000001,gross_salary=5200001,net_salary=4900001 WHERE id=11');
  const changedBefore=await state();
  const changedResponse=await post(changedDigest);
  assert.equal(changedResponse.status,409,'salary drift after approval must fail');
  assert.equal((await changedResponse.json()).code,'PAYROLL_INTEGRITY_BLOCKED');
  assert.deepEqual(await state(),changedBefore);
  pass('posting HTTP rejects changed salary snapshot after signed approval');

  // Two signed requests arriving together must create one accrual, repayment,
  // audit, and outbox row. The second response may be a verified replay only.
  const parallelDigest=await prepare();
  const parallelResponse=await Promise.all([post(parallelDigest),post(parallelDigest)]);
  assert.deepEqual(parallelResponse.map(x=>x.status),[200,200]);
  const parallelData=await Promise.all(parallelResponse.map(x=>x.json()));
  assert.deepEqual(parallelData.map(x=>x.reused).sort(),[false,true]);
  assert.equal(parallelData[0].entryId,parallelData[1].entryId);
  const parallelState=await state();
  assert.deepEqual(parallelState,{entries:1,lines:6,audit:1,outbox:1,
   balance:'400000.00',reservation:'confirmed',status:'approved',
   entry_id:parallelData[0].entryId,payments:0,repayments:1});
  pass('two simultaneous signed posting HTTP requests settle once with verified replay');

  const rollbackDigest=await prepare();
  await admin.query(`CREATE FUNCTION ci_integrated_repayment_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_REPAYMENT_FAILURE'; END $$;
   CREATE TRIGGER ci_integrated_repayment_fault BEFORE INSERT ON cash_advance_repayments
   FOR EACH ROW EXECUTE FUNCTION ci_integrated_repayment_fault()`);
  try{
   const failedHttp=await post(rollbackDigest);
   assert.equal(failedHttp.status,503,'Sensitive DB failures must be HTTP-redacted');
   const safeError=await failedHttp.json();
   assert.equal(safeError.code,'PAYROLL_POSTING_UNAVAILABLE');
   assert.equal(JSON.stringify(safeError).includes('SYNTHETIC_REPAYMENT_FAILURE'),false);
   assert.deepEqual(await state(),{entries:0,lines:0,audit:0,outbox:0,
    balance:'500000.00',reservation:'prepared',status:'reviewed',
    entry_id:null,payments:0,repayments:0});
   pass('native posting failure rolls back the journal, outbox, kasbon and ledger on the same approved run');
  }finally{
   await admin.query('DROP TRIGGER ci_integrated_repayment_fault ON cash_advance_repayments; DROP FUNCTION ci_integrated_repayment_fault()');
  }
  const recoveryHttp=await post(rollbackDigest);
  assert.equal(recoveryHttp.status,200,'Recovered native posting must return HTTP200');
  const recovery=await recoveryHttp.json();
  assert.equal(recovery.reused,false);
  const recovered=await state();assert.equal(recovered.entries,1);
  assert.equal(recovered.repayments,1);assert.equal(recovered.balance,'400000.00');
  assert.equal(recovered.payments,0);
  pass('original signed-approved run can recover once after a fully rolled-back failure');
  console.log('PAYROLL_SIGNED_CALCULATE_APPROVAL_NATIVE_HTTP_LEDGER_POSTGRES_PASS',integratedPass,
   'SIGNED_COOKIE_ISSUED_BY_REAL_OTP_HANDLER',true,'SMTP_NETWORK_DELIVERY_USED',false,
   'LIVE_CST_DEV_OR_PROD_USED',false,'SALARY_TRANSFER_SENT',false);
 }finally{
   await new Promise<void>(resolve=>server.close(()=>resolve()));
   await Promise.allSettled([calcPool.end(),approvePool.end()]);
   delete (globalThis as any).__payrollIntegrated;
   for(const [key,value] of Object.entries(priorEnvs)){
     if(value===undefined)delete process.env[key];else process.env[key]=value as string;
   }
 }
}finally{if(writer)await writer.end();await admin.end();}
