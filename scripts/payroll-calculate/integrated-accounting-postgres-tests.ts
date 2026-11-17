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
 const calcUrl=new URL(process.env.PAYROLL_PG_E2E_URL!);
 calcUrl.username='bizportal_payroll_dev';calcUrl.password='fixture-calc-only-2026';
 const approveUrl=new URL(process.env.PAYROLL_PG_E2E_URL!);
 approveUrl.username='bizportal_payroll_approver_dev';approveUrl.password='fixture-approval-only-2026';
 const calcPool=new Pool({connectionString:calcUrl.href,max:2});
 const approvePool=new Pool({connectionString:approveUrl.href,max:1});
 (globalThis as any).__payrollIntegrated={admin,calculate:calcPool,approve:approvePool};
 const previousEnvKeys=['APP_ENV','NODE_ENV','SESSION_SECRET','BIZPORTAL_SESSION_SECRET',
 'BIZPORTAL_SIGNED_OTP_ENABLED_DEV','BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV',
 'PAYROLL_DEV_CALCULATE_ENABLED','PAYROLL_DEV_CALCULATE_ALLOWED_ORIGIN',
 'PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED','PAYROLL_DEV_ATOMIC_POSTING_ENABLED',
 'PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED'] as const;
 const priorEnvs=Object.fromEntries(previousEnvKeys.map(key=>[key,process.env[key]]));
 process.env.APP_ENV='development';process.env.NODE_ENV='test';
 process.env.SESSION_SECRET='payroll-only-fixture-HMAC-secret-2026-not-live';
 delete process.env.BIZPORTAL_SESSION_SECRET;
 process.env.BIZPORTAL_SIGNED_OTP_ENABLED_DEV='true';
 delete process.env.BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV;
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
 const signedCookie=makeCookie();
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
  const digest=await prepare();
  const before=await state();
  assert.deepEqual(before,{entries:0,lines:0,audit:0,outbox:0,
   balance:'500000.00',reservation:'prepared',status:'reviewed',
   entry_id:null,payments:0,repayments:0});
  pass('one signed HTTP Calculate and approval persist a clean Reviewed run and prepared hold');
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
   'SIGNED_COOKIE_ISSUED_BY_SYNTHETIC_FIXTURE',true,'REAL_EMAIL_OTP_SENT',false,
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
