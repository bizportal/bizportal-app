 // Additional privilege checks only on the existing disposable fixture.
 // No live SET ROLE, GRANT, credential or HTTP/session test is performed.
 await admin.query((await import('node:fs')).readFileSync('__ROOT__/scripts/payroll-atomic-rehearsal/least-privilege-fixture.sql','utf8'));
 let privilegeChecks=0;
 const privilegeOk=(name:string)=>{privilegeChecks++;console.log('PASS PERMISSION',name);};
 await reset();
 const limited=await writer!.connect();
 try{
  const identity=(await limited.query('SELECT current_user,session_user,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(identity.current_user,'bizportal_payroll_settlement_dev');
  assert.equal(identity.session_user,identity.current_user);assert.equal(identity.rolsuper,false);assert.equal(identity.rolbypassrls,false);
  assert.equal(identity.rolcreatedb,false);assert.equal(identity.rolcreaterole,false);assert.equal(identity.rolreplication,false);
  assert.equal((await limited.query('SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=current_user')).rows[0].n,0);
  privilegeOk('direct non-superuser, non-bypass identity retained');

  const acl=(await limited.query(`SELECT c.relname,has_table_privilege(current_user,c.oid,'UPDATE') AS whole_table_update,
   has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,
   has_table_privilege(current_user,c.oid,'TRUNCATE') AS can_truncate
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`)).rows;
  assert.ok(acl.length>=18);assert.equal(acl.some(r=>r.whole_table_update||r.can_delete||r.can_truncate),false);
  privilegeOk('no table-wide UPDATE, DELETE or TRUNCATE remains anywhere in fixture public schema');
  const forbidden=(await limited.query(`SELECT
   has_column_privilege(current_user,'payroll_runs','approved_at','UPDATE') AS approval,
   has_column_privilege(current_user,'payroll_runs','notes','UPDATE') AS receipt,
   has_column_privilege(current_user,'payroll_runs','payment_entry_id','UPDATE') AS payout_link,
   has_column_privilege(current_user,'payroll_items','base_salary','UPDATE') AS salary,
   has_column_privilege(current_user,'cash_advances','amount','UPDATE') AS principal,
   has_table_privilege(current_user,'salary_payments','INSERT') AS payout,
   has_schema_privilege(current_user,'public','CREATE') AS ddl`)).rows[0];
  assert.equal(Object.values(forbidden).some(Boolean),false);
  privilegeOk('approval receipt, salary, loan principal, bank-payment link, payout and schema writes absent');

  await limited.query('BEGIN');
  await limited.query("SELECT set_config('app.payroll_company_id','1',true)");
  for(const table of ['employees','chart_of_accounts','payroll_items','accounting_settings','financial_periods']){
   const r=await limited.query(`SELECT * FROM ${table} FOR SHARE`);assert.ok(r.rows.length>0,table+' share lock should remain usable');
  }
  await limited.query('ROLLBACK');privilegeOk('SELECT FOR SHARE retains actual access without broad write grants');

  const denied:readonly [string,string][]=[
   ['rewrite approved_at',"UPDATE payroll_runs SET approved_at=now() WHERE id=32"],
   ['rewrite approval receipt',"UPDATE payroll_runs SET notes='changed' WHERE id=32"],
   ['link salary payment',"UPDATE payroll_runs SET payment_entry_id=1 WHERE id=32"],
   ['change salary amount',"UPDATE payroll_items SET base_salary=1 WHERE id=11"],
   ['change loan principal',"UPDATE cash_advances SET amount=1 WHERE id=801"],
   ['change prior cash repayments',"UPDATE cash_advances SET paid_amount=1 WHERE id=801"],
   ['change loan receivable account',"UPDATE cash_advances SET receivable_account_id=10 WHERE id=801"],
   ['change configured COA',"UPDATE accounting_settings SET salary_expense_account_id=14 WHERE company_id=1"],
   ['create salary payment',"INSERT INTO salary_payments DEFAULT VALUES"],
   ['delete repayment ledger',"DELETE FROM cash_advance_repayments"],
   ['truncate payroll',"TRUNCATE payroll_runs"],
   ['create schema object',"CREATE TABLE ci_unexpected_writer_table(id integer)"],
   ['mutate employee lock-only column',"UPDATE employees SET id=id WHERE id=101"],
   ['mutate COA lock-only column',"UPDATE chart_of_accounts SET id=id WHERE id=10"],
   ['mutate mapping lock-only column',"UPDATE accounting_settings SET id=id WHERE company_id=1"],
   ['mutate period lock-only column',"UPDATE financial_periods SET company_id=company_id WHERE company_id=1"],
  ];
  for(const [name,query] of denied){
   await limited.query('BEGIN');await limited.query("SELECT set_config('app.payroll_company_id','1',true)");
   try {await assert.rejects(limited.query(query),(error:any)=>error.code==='42501');}
   finally{await limited.query('ROLLBACK');}
   privilegeOk(name+' is refused');
  }
  await limited.query('BEGIN');await limited.query("SELECT set_config('app.payroll_company_id','2',true)");
  const foreign=(await limited.query('SELECT id FROM payroll_runs WHERE id=32 FOR UPDATE')).rows;
  assert.equal(foreign.length,0);await limited.query('ROLLBACK');privilegeOk('foreign company payroll cannot be read or locked');
  await limited.query('BEGIN');
  const unscoped=(await limited.query('SELECT id FROM payroll_runs')).rows;
  assert.equal(unscoped.length,0);await limited.query('ROLLBACK');privilegeOk('transaction scope does not leak into subsequent unscoped query');
 }finally{limited.release();}
 await unchanged();
 const runtimePreflight=await import('./payroll-accounting-runtime-preflight');
 const originalAppEnv=process.env.APP_ENV;
 try {
  process.env.APP_ENV='development';
  const prepared=await runtimePreflight.verifyPayrollSettlementRuntime(writer!);
  assert.deepEqual(prepared,{structuralChecksPassed:true,checkedTables:18,readOnly:true,
   runtimePostingTested:false,policySemanticsVerified:false});
  await unchanged();privilegeOk('actual restricted PostgreSQL connection passes read-only runtime preflight across 18 tables');
 } finally { if(originalAppEnv===undefined)delete process.env.APP_ENV;else process.env.APP_ENV=originalAppEnv; }
 console.log('PERMISSION_BOUNDARY_CHECKS_PASS' ,privilegeChecks,'LIVE_GRANTS_CHANGED',false);
 // Continue ALL 35 original application scenarios with this same limited pool.
