{
 // Existing disposable packaged runner only; no HTTP/auth/OTP/GCP usage.
 const priorChecks=passed;let linkedChecks=0;
 const linkedOk=(name:string)=>{linkedChecks++;console.log('PASS LEGACY_INSTALLMENT',name);};
 const previousLinkFlag=process.env.PAYROLL_DEV_LEGACY_INSTALLMENT_LINK_ENABLED;
 const paymentEvidence=async()=>({state:await state(),schedules:(await admin.query('SELECT * FROM cash_advance_installment_schedules ORDER BY id')).rows,
  allocations:(await admin.query('SELECT * FROM payroll_cash_advance_allocations ORDER BY id')).rows});
 const prepareLinked=async()=>{
  await reset();await admin.query('DELETE FROM employees WHERE company_id=1 AND id<>101');
  const f=fixture();
  for(let n=1;n<=5;n++){
   const dt=new Date(Date.UTC(2026,9+n,10)).toISOString().slice(0,10);
   await admin.query(`INSERT INTO cash_advance_installment_schedules(id,company_id,advance_id,installment_number,
     due_date,amount,status,created_at,updated_at) VALUES($1,1,801,$2,$3,100000,'pending','2026-10-01','2026-10-01')`,[900+n,n,dt]);
  }
  await admin.query(`INSERT INTO payroll_cash_advance_allocations(id,payroll_item_id,cash_advance_id,
    installment_schedule_id,amount,created_at) VALUES(1001,11,801,901,100000,'2026-11-01')`);
  return f;
 };
 const postLinked=async(f=fixture())=>{
  process.env.APP_ENV='development';process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='true';
  const receipt=JSON.parse(f.run.notes!.split(PAYROLL_SUPER_ADMIN_APPROVAL_MARKER+' ')[1]);
  return postReviewedPayrollAccrualTransaction(writer!,patched.PayrollJournalService,{companyId:1,runId:f.run.id,
    postingDate:f.postingDate,expectedDigest:receipt.digest,actor:{id:receipt.actorId,email:receipt.actorEmail,role:'super_admin'}});
 };
 const rejectUnchanged=async(regex:RegExp,f=fixture())=>{
  const before=await paymentEvidence();await assert.rejects(postLinked(f),regex);assert.deepEqual(await paymentEvidence(),before);
 };
 const sql42501=(e:unknown)=>{let x:any=e;for(let n=0;n<5&&x;n++,x=x.cause)if(x.code==='42501')return true;return false;};
 try{
  await prepareLinked();process.env.PAYROLL_DEV_LEGACY_INSTALLMENT_LINK_ENABLED='false';
  await rejectUnchanged(/LEGACY_ALLOCATIONS_REQUIRE_RECONCILIATION/);linkedOk('default-OFF retains previous legacy allocation refusal');
  process.env.PAYROLL_DEV_LEGACY_INSTALLMENT_LINK_ENABLED='true';
  const beforeMissing=await paymentEvidence();await assert.rejects(postLinked(),sql42501);
  assert.deepEqual(await paymentEvidence(),beforeMissing);linkedOk('feature ON without extra scoped permissions fails closed');
  // Fixture-only grant contract, not a deployable live migration.
  await admin.query(`GRANT UPDATE(id) ON payroll_cash_advance_allocations TO bizportal_payroll_settlement_dev;
    CREATE POLICY ci_allocation_lock_scope ON payroll_cash_advance_allocations FOR UPDATE
      TO bizportal_payroll_settlement_dev USING(EXISTS(SELECT 1 FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id
        WHERE i.id=payroll_cash_advance_allocations.payroll_item_id AND r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer))
      WITH CHECK(EXISTS(SELECT 1 FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id
        WHERE i.id=payroll_cash_advance_allocations.payroll_item_id AND r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer));
    CREATE TRIGGER ci_allocation_lock_only BEFORE UPDATE ON payroll_cash_advance_allocations
    FOR EACH ROW EXECUTE FUNCTION ci_payroll_lock_only();
    GRANT UPDATE(status,repayment_id,paid_date,paid_amount,accounting_entry_id,payroll_item_id,updated_at)
      ON cash_advance_installment_schedules TO bizportal_payroll_settlement_dev;
    CREATE POLICY ci_installment_update ON cash_advance_installment_schedules FOR UPDATE
      TO bizportal_payroll_settlement_dev
      USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer
        AND EXISTS(SELECT 1 FROM cash_advances a WHERE a.id=cash_advance_installment_schedules.advance_id AND a.company_id=cash_advance_installment_schedules.company_id))
      WITH CHECK(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer
        AND EXISTS(SELECT 1 FROM cash_advances a WHERE a.id=cash_advance_installment_schedules.advance_id AND a.company_id=cash_advance_installment_schedules.company_id));`);
  const preflight=await import('./payroll-accounting-runtime-preflight');
  assert.equal((await preflight.verifyPayrollSettlementRuntime(writer!)).structuralChecksPassed,true);
  linkedOk('optional 18-table preflight checks schedule write and protected columns using direct restricted identity');
  await prepareLinked();const success=await postLinked();
  const paid=(await admin.query(`SELECT status,repayment_id,paid_amount::text,paid_date::text,
    accounting_entry_id,payroll_item_id FROM cash_advance_installment_schedules WHERE id=901`)).rows[0];
  assert.equal(paid.status,'paid');assert.equal(paid.paid_amount,'100000.00');assert.equal(paid.paid_date,'2026-11-17');
  assert.equal(paid.accounting_entry_id,success.entryId);assert.equal(paid.payroll_item_id,11);
  assert.equal(paid.repayment_id,(await admin.query('SELECT id FROM cash_advance_repayments')).rows[0].id);
  assert.equal((await state()).balance,'400000.00');assert.equal((await state()).payments,0);
  assert.equal((await admin.query("SELECT count(*)::int n FROM cash_advance_installment_schedules WHERE status='pending'")).rows[0].n,4);
  linkedOk('one existing full installment atomically links original schedule, repayment, journal and reservation');
  const firstEvidence=await paymentEvidence();assert.equal((await postLinked()).reused,true);
  assert.deepEqual(await paymentEvidence(),firstEvidence);linkedOk('replay checks persisted schedule and repayment without second balance deduction');
  await prepareLinked();const concurrent=await Promise.all([postLinked(),postLinked()]);
  assert.equal(concurrent.filter(r=>!r.reused).length,1);assert.equal((await state()).repayments,1);
  linkedOk('concurrent same-run requests settle one installment only');

  for(const [name,query,pattern] of [
   ['missing explicit allocation','DELETE FROM payroll_cash_advance_allocations',/EXPLICIT_ALLOCATION_REQUIRED/],
   ['allocation with no schedule','UPDATE payroll_cash_advance_allocations SET installment_schedule_id=NULL',/LINK_NOT_EXACT/],
   ['partial legacy installment','UPDATE payroll_cash_advance_allocations SET amount=50000',/LINK_NOT_EXACT/],
   ['allocation added after approval',"UPDATE payroll_cash_advance_allocations SET created_at='2026-11-18'",/LINK_NOT_EXACT/],
   ['changed schedule after approval',"UPDATE cash_advance_installment_schedules SET updated_at='2026-11-18' WHERE id=901",/SCHEDULE_NOT_CLEAN_DUE/],
   ['foreign company schedule','UPDATE cash_advance_installment_schedules SET company_id=2 WHERE id=901',/LINK_NOT_EXACT/],
   ['wrong advance allocation','UPDATE payroll_cash_advance_allocations SET cash_advance_id=802',/LINK_NOT_EXACT/],
   ['future due day',"UPDATE cash_advance_installment_schedules SET due_date='2026-11-18' WHERE id=901",/SCHEDULE_NOT_CLEAN_DUE/],
   ['future Payroll period',"UPDATE cash_advance_installment_schedules SET due_date='2026-12-01' WHERE id=901",/LINK_NOT_EXACT/],
   ['inconsistent schedule balance','UPDATE cash_advance_installment_schedules SET amount=1 WHERE id=905',/SCHEDULE_BALANCE_OR_ORDER_MISMATCH/],
   ['preexisting partial schedule payment','UPDATE cash_advance_installment_schedules SET paid_amount=1 WHERE id=901',/SCHEDULE_NOT_CLEAN_DUE/],
   ['waived schedule',"UPDATE cash_advance_installment_schedules SET status='waived' WHERE id=901",/SCHEDULE_NOT_CLEAN_DUE/],
   ['duplicate allocation reference',"INSERT INTO payroll_cash_advance_allocations(payroll_item_id,cash_advance_id,installment_schedule_id,amount,created_at) VALUES(11,801,901,100000,'2026-11-01')",/DUPLICATE_LINK/],
  ] as const){await prepareLinked();await admin.query(query);await rejectUnchanged(pattern);linkedOk(name+' rejected without changing financial data');}
  const skip=await prepareLinked();skip.postingDate='2026-12-17';skip.run.month=12;sign(skip);
  await admin.query("UPDATE payroll_runs SET month=12,notes=$1 WHERE id=32",[skip.run.notes]);
  await admin.query("UPDATE payroll_kasbon_auto_reservations SET period='2026-12-01'");
  await admin.query('UPDATE payroll_cash_advance_allocations SET installment_schedule_id=902');
  await rejectUnchanged(/SCHEDULE_BALANCE_OR_ORDER_MISMATCH/,skip);linkedOk('oldest outstanding installment cannot be skipped');
  await prepareLinked();await admin.query("UPDATE cash_advance_installment_schedules SET due_date='2026-10-10',status='overdue' WHERE id=901");
  await postLinked();linkedOk('oldest overdue complete installment is supported');
  for(const [name,query,pattern] of [
   ['missing allocation','DELETE FROM payroll_cash_advance_allocations',/PAID_LINK_MISSING/],
   ['changed repayment linkage','UPDATE cash_advance_installment_schedules SET repayment_id=NULL WHERE id=901',/PAID_EVIDENCE_INVALID/],
   ['changed journal linkage','UPDATE cash_advance_installment_schedules SET accounting_entry_id=99999 WHERE id=901',/LEGACY_INSTALLMENT_REPAYMENT_CHANGED/],
   ['changed paid amount','UPDATE cash_advance_installment_schedules SET paid_amount=99999 WHERE id=901',/PAID_EVIDENCE_INVALID/],
   ['changed paid date',"UPDATE cash_advance_installment_schedules SET paid_date='2026-11-16' WHERE id=901",/LEGACY_INSTALLMENT_REPAYMENT_CHANGED/],
  ] as const){await prepareLinked();await postLinked();await admin.query(query);await rejectUnchanged(pattern);linkedOk('replay refuses '+name+' without repairing history');}
  for(const suppress of [false,true]){
   await prepareLinked();const before=await paymentEvidence();
   await admin.query(`CREATE FUNCTION ci_installment_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${suppress?"RETURN NULL;":"RAISE EXCEPTION 'SYNTHETIC_INSTALLMENT_FAILURE';"} END $$;
     CREATE TRIGGER ci_installment_failure BEFORE UPDATE ON cash_advance_installment_schedules FOR EACH ROW EXECUTE FUNCTION ci_installment_failure()`);
   try{await assert.rejects(postLinked(),suppress?/CONFIRMATION_CHANGED/:/SYNTHETIC_INSTALLMENT_FAILURE/);assert.deepEqual(await paymentEvidence(),before);}
   finally{await admin.query('DROP TRIGGER ci_installment_failure ON cash_advance_installment_schedules;DROP FUNCTION ci_installment_failure()');}
   linkedOk(suppress?'suppressed schedule update rolls back journal, repayment and advance':'schedule update failure rolls back journal, repayment and advance');
  }
  await prepareLinked();await admin.query("UPDATE financial_periods SET is_closed=true");
  await rejectUnchanged(/POSTING_PERIOD_CLOSED/);linkedOk('linked schedule does not bypass a closed accounting period');
  const locked=await writer!.connect();
  try{
   for(const q of ['UPDATE cash_advance_installment_schedules SET amount=1 WHERE id=901',
     'UPDATE cash_advance_installment_schedules SET company_id=2 WHERE id=901',
     'UPDATE payroll_cash_advance_allocations SET amount=1 WHERE id=1001',
     'UPDATE payroll_cash_advance_allocations SET id=id WHERE id=1001']){
    await locked.query('BEGIN');await locked.query("SELECT set_config('app.payroll_company_id','1',true)");
    try{await assert.rejects(locked.query(q),sql42501);}finally{await locked.query('ROLLBACK');}
   }
  }finally{locked.release();}
  linkedOk('writer cannot alter installment principal, company, allocation amount or lock-only identity');

  // Five existing schedules reused across five distinct approved synthetic runs.
  const runs=[await prepareLinked()];await postLinked(runs[0]!);
  for(let n=1;n<5;n++){
   const f=fixture(),m=new Date(Date.UTC(2026,10+n,17));f.run.id=40+n;f.run.year=m.getUTCFullYear();f.run.month=m.getUTCMonth()+1;
   f.postingDate=m.toISOString().slice(0,10);f.run.approvedAt=f.postingDate+'T10:00:00Z';
   f.items=f.items.map(i=>({...i,id:20+n}));sign(f);
   await admin.query('INSERT INTO payroll_runs(id,company_id,year,month,status,posting_status,approved_at,notes) VALUES($1,1,$2,$3,\'reviewed\',\'pending\',$4,$5)',[f.run.id,f.run.year,f.run.month,f.run.approvedAt,f.run.notes]);
   const i=f.items[0]!;
   await admin.query(`INSERT INTO payroll_items(id,run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,total_deductions,net_salary,is_paid)
    VALUES($1,$2,101,5000000,200000,5200000,100000,50000,50000,0,100000,300000,4900000,false)`,[i.id,f.run.id]);
   await admin.query(`INSERT INTO payroll_kasbon_auto_reservations(id,company_id,run_id,advance_id,payroll_item_id,employee_id,amount,balance_at_preparation,state,period)
    VALUES($1,1,$2,801,$3,101,100000,$4,'prepared',$5)`,[510+n,f.run.id,i.id,(500000-100000*n).toFixed(2),f.postingDate.slice(0,7)+'-01']);
   await admin.query(`INSERT INTO payroll_cash_advance_allocations(id,payroll_item_id,cash_advance_id,installment_schedule_id,amount,created_at)
    VALUES($1,$2,801,$3,100000,'2026-10-01')`,[1010+n,i.id,901+n]);
   await admin.query('INSERT INTO financial_periods SELECT 1,$1,$2,false,false WHERE NOT EXISTS(SELECT 1 FROM financial_periods WHERE company_id=1 AND year=$1 AND month=$2)',[f.run.year,f.run.month]);
   await postLinked(f);runs.push(f);
  }
  const final=(await admin.query(`SELECT remaining_amount::text,paid_amount::text,settled_amount::text FROM cash_advances WHERE id=801`)).rows[0];
  assert.deepEqual(final,{remaining_amount:'0.00',paid_amount:'0.00',settled_amount:'500000.00'});
  assert.equal((await admin.query("SELECT count(*)::int n FROM cash_advance_installment_schedules WHERE status='paid'")).rows[0].n,5);
  assert.equal((await state()).repayments,5);assert.equal((await state()).entries,5);assert.equal((await state()).payments,0);
  linkedOk('five original installments across year boundary settle exactly five schedules with conserved principal');
  const allEvidence=await paymentEvidence();for(const f of runs)assert.equal((await postLinked(f)).reused,true);
  assert.deepEqual(await paymentEvidence(),allEvidence);linkedOk('all earlier linked periods replay after final settlement without duplicate posting or repayment');
  // Regression: the pre-fix local code accepted two matching dates which
  // disagreed with the posted journal. Keep the verified journal authoritative.
  for (const alteredDate of ['2026-11-16','2026-12-01']) {
    await prepareLinked();await postLinked();
    await admin.query('UPDATE cash_advance_installment_schedules SET paid_date=$1 WHERE id=901',[alteredDate]);
    await admin.query('UPDATE cash_advance_repayments SET date=$1',[alteredDate]);
    await rejectUnchanged(/REPAYMENT_LEDGER_NOT_VERIFIED/);
    assert.equal((await admin.query("SELECT date::text FROM accounting_entries WHERE source='payroll'")).rows[0].date,'2026-11-17');
    linkedOk('correlated schedule/repayment date drift '+alteredDate+' is rejected against original journal');
  }
  await prepareLinked();await postLinked();
  const laterRequest=fixture();laterRequest.postingDate='2026-12-01';
  const unchangedDates=await paymentEvidence();assert.equal((await postLinked(laterRequest)).reused,true);
  assert.deepEqual(await paymentEvidence(),unchangedDates);
  linkedOk('later replay request date does not rewrite original schedule, repayment or journal dates');
  assert.equal(passed,priorChecks);assert.equal(outsideQueries,0);
  console.log('LEGACY_INSTALLMENT_LINK_POSTGRES_PASS',linkedChecks,'LIVE_DATABASE_USED',false,'SALARY_PAYMENT_SENT',false);
 }finally{if(previousLinkFlag===undefined)delete process.env.PAYROLL_DEV_LEGACY_INSTALLMENT_LINK_ENABLED;else process.env.PAYROLL_DEV_LEGACY_INSTALLMENT_LINK_ENABLED=previousLinkFlag;}
}
