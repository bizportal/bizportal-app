{
 // Runs AFTER the original packaged writer tests. It creates only synthetic
 // fixture Payroll rows, directly invokes existing services and reads back SQL.
 // No HTTP identity, GCP, bank transfer or live Supabase database is used.
 const crossPreviousCount=passed;
 let crossChecks=0;
 const crossOk=(name:string)=>{crossChecks++;console.log('PASS CROSS_PERIOD',name);};
 const kasbonCalc=await import('./payroll-kasbon-automatic');
 const readLoan=async()=> (await admin.query(`SELECT id,company_id AS "companyId",employee_id AS "employeeId",type,status,
 lifecycle_status AS "lifecycleStatus",currency,amount::text,paid_amount::text AS "paidAmount",
 settled_amount::text AS "settledAmount",remaining_amount::text AS "remainingAmount",
 approved_at::text AS "approvedAt",approved_by AS "approvedBy",disbursed_at::text AS "disbursedAt",
 disbursed_by AS "disbursedBy",accounting_entry_id AS "accountingEntryId",posting_status AS "postingStatus",
 voided_at::text AS "voidedAt" FROM cash_advances WHERE id=801`)).rows[0];
 const projectLoan=async(year:number,month:number,choice:'FULL'|'INSTALLMENT'='INSTALLMENT')=>{
  const a=await readLoan();
  const holds=(await admin.query(`SELECT advance_id AS "advanceId",period::text,amount::text,state
   FROM payroll_kasbon_auto_reservations WHERE company_id=1 AND advance_id=801 ORDER BY period`)).rows;
  return kasbonCalc.calculateKasbonAutoDeduction([a],[{advanceId:801,choice,
   installmentAmount:choice==='FULL'?null:'100000.00',firstPeriod:'2026-11-01'}],holds,1,101,year,month);
 };
 const initial=async(amount='500000.00',cash='0.00',settled='0.00',balance='500000.00',deduction='100000.00')=>{
  await reset();await admin.query('DELETE FROM employees WHERE company_id=1 AND id<>101');
  const f=fixture();const total=kasbonCalc.moneyToCents('200000.00')+kasbonCalc.moneyToCents(deduction);
  f.items=f.items.map(i=>({...i,kasbonDeduction:deduction,totalDeductions:kasbonCalc.centsToMoney(total),
   netSalary:kasbonCalc.centsToMoney(kasbonCalc.moneyToCents(i.grossSalary)-total)}));
  f.reservations=f.reservations.map(h=>({...h,amount:deduction,heldBalance:balance,currentBalance:balance}));sign(f);
  await admin.query('UPDATE cash_advances SET amount=$1,paid_amount=$2,settled_amount=$3,remaining_amount=$4 WHERE id=801',[amount,cash,settled,balance]);
  await admin.query('UPDATE payroll_items SET kasbon_deduction=$1,total_deductions=$2,net_salary=$3 WHERE id=11',[deduction,f.items[0]!.totalDeductions,f.items[0]!.netSalary]);
  await admin.query('UPDATE payroll_kasbon_auto_reservations SET amount=$1,balance_at_preparation=$2 WHERE id=501',[deduction,balance]);
  await admin.query('UPDATE payroll_runs SET notes=$1 WHERE id=32',[f.run.notes]);return f;
 };
 const postPeriod=async(f:ReturnType<typeof fixture>)=>{
  const receipt=JSON.parse(f.run.notes!.split(PAYROLL_SUPER_ADMIN_APPROVAL_MARKER+' ')[1]);
  process.env.APP_ENV='development';process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='true';
  return postReviewedPayrollAccrualTransaction(writer!,patched.PayrollJournalService,{
   companyId:1,runId:f.run.id,postingDate:f.postingDate,expectedDigest:receipt.digest,
   actor:{id:receipt.actorId,email:receipt.actorEmail,role:'super_admin'}});
 };
 const addNext=async(runId:number,year:number,month:number,deduction:string)=>{
  const loan=await readLoan(),f=fixture(),itemId=1000+runId,period=kasbonCalc.payrollMonth(year,month);
  f.run.id=runId;f.run.year=year;f.run.month=month;f.postingDate=period.slice(0,7)+'-17';
  const total=kasbonCalc.moneyToCents('200000.00')+kasbonCalc.moneyToCents(deduction);
  f.items=f.items.map(i=>({...i,id:itemId,kasbonDeduction:deduction,totalDeductions:kasbonCalc.centsToMoney(total),
   netSalary:kasbonCalc.centsToMoney(kasbonCalc.moneyToCents(i.grossSalary)-total)}));
  f.reservations=f.reservations.map(h=>({...h,runId,payrollItemId:itemId,amount:deduction,
   heldBalance:loan.remainingAmount,currentBalance:loan.remainingAmount}));sign(f);
  await admin.query('INSERT INTO financial_periods(company_id,year,month,is_closed,override_allowed) VALUES(1,$1,$2,false,false)',[year,month]);
  await admin.query("INSERT INTO payroll_runs(id,company_id,year,month,status,posting_status,approved_at,notes) VALUES($1,1,$2,$3,'draft','pending',$4,$5)",[runId,year,month,f.run.approvedAt,f.run.notes]);
  const i=f.items[0]!;
  await admin.query('INSERT INTO payroll_items(id,run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,total_deductions,net_salary,is_paid) VALUES($1,$2,101,5000000,200000,5200000,100000,50000,50000,0,$3,$4,$5,false)',[itemId,runId,deduction,i.totalDeductions,i.netSalary]);
  await admin.query("INSERT INTO payroll_kasbon_auto_reservations(id,company_id,run_id,advance_id,payroll_item_id,employee_id,amount,balance_at_preparation,state,period) VALUES($1,1,$2,801,$3,101,$4,$5,'prepared',$6)",[2000+runId,runId,itemId,deduction,loan.remainingAmount,period]);
  await admin.query("UPDATE payroll_runs SET status='reviewed' WHERE id=$1",[runId]);return f;
 };
 const firstPeriod=await initial();await postPeriod(firstPeriod);
 assert.deepEqual((await readLoan()).paidAmount,'0.00');assert.equal((await readLoan()).settledAmount,'100000.00');
 assert.equal((await readLoan()).remainingAmount,'400000.00');
 crossOk('first noncash deduction preserves cash repayments and conserves principal');
 const next=await projectLoan(2026,12);assert.equal(next.total,'100000.00');assert.equal(next.canApply,true);
 crossOk('actual post-first-period balance is accepted by original installment projector');
 const repeatedPreview=await projectLoan(2026,11);assert.equal(repeatedPreview.canApply,false);
 assert.equal(repeatedPreview.rows[0]!.issue,'POTONGAN_PERIODE_SUDAH_DIKONFIRMASI');
 crossOk('same-period confirmed deduction cannot be prepared twice');
 const histories=[firstPeriod];
 for(const [n,year,month] of [[1,2026,12],[2,2027,1],[3,2027,2],[4,2027,3]]){
  const projected=await projectLoan(year!,month!);assert.equal(projected.total,'100000.00');
  const f=await addNext(100+n!,year!,month!,projected.total!);histories.push(f);
  await postPeriod(f);const a=await readLoan();
  kasbonCalc.assertKasbonPrincipalBalance(a.amount,a.paidAmount,a.settledAmount,a.remainingAmount);
  assert.equal(a.paidAmount,'0.00');assert.equal(a.settledAmount,kasbonCalc.centsToMoney(BigInt(n!+1)*10000000n));
  crossOk('consecutive installment '+year+'-'+month+' posts once with preserved principal');
 }
 const finished=await readLoan();assert.equal(finished.remainingAmount,'0.00');assert.equal(finished.status,'repaid');assert.equal(finished.lifecycleStatus,'settled');
 assert.equal((await admin.query('SELECT count(*)::int n FROM cash_advance_repayments')).rows[0].n,5);
 assert.equal((await admin.query('SELECT count(*)::int n FROM accounting_entries')).rows[0].n,5);
 assert.equal((await admin.query('SELECT count(*)::int n FROM salary_payments')).rows[0].n,0);
 crossOk('five periods end at zero with five receipts, five journals and no salary transfer');
 const beforeReplay=await state();for(const f of histories)assert.equal((await postPeriod(f)).reused,true);
 assert.deepEqual(await state(),beforeReplay);crossOk('all earlier periods can replay after later settlement without a second deduction');
 const afterPaid=await projectLoan(2027,4);assert.equal(afterPaid.total,'0.00');assert.equal(afterPaid.canApply,false);
 crossOk('fully settled loan is not charged in the next period');
 const mixed=await initial('500000.00','100000.00','50000.00','350000.00');await postPeriod(mixed);
 const mixedRead=await readLoan();assert.equal(mixedRead.paidAmount,'100000.00');assert.equal(mixedRead.settledAmount,'150000.00');assert.equal(mixedRead.remainingAmount,'250000.00');
 assert.equal((await projectLoan(2026,12)).total,'100000.00');crossOk('prior cash and prior expense settlement are preserved separately');
 const full=await initial('500000.00','100000.00','50000.00','350000.00','350000.00');await postPeriod(full);
 const fullRead=await readLoan();assert.equal(fullRead.paidAmount,'100000.00');assert.equal(fullRead.settledAmount,'400000.00');assert.equal(fullRead.remainingAmount,'0.00');
 crossOk('FULL payoff from mixed history reduces only remaining debt, not the original principal again');
 const fraction=await initial('200000.01','50000.00','125000.00','25000.01','25000.01');
 assert.equal((await projectLoan(2026,11)).total,'25000.01');await postPeriod(fraction);
 const fractionalRead=await readLoan();assert.equal(fractionalRead.paidAmount,'50000.00');assert.equal(fractionalRead.settledAmount,'150000.01');assert.equal(fractionalRead.remainingAmount,'0.00');
 crossOk('final fractional installment conserves every cent');
 const oldDouble=await initial('500000.00','100000.00','100000.00','400000.00');const beforeInvalid=await state();
 await assert.rejects(postPeriod(oldDouble),/ADVANCE_TOTALS_INCONSISTENT/);assert.deepEqual(await state(),beforeInvalid);
 crossOk('historical double-counted summary fails closed without automatic repair or posting');
 const otherFailure=await initial('500000.00','100000.00','50000.00','350000.00');const beforeFailure=await state();
 await admin.query(`CREATE FUNCTION ci_cross_period_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_KASBON_RECEIPT_FAILURE'; END $$; CREATE TRIGGER ci_cross_period_failure BEFORE INSERT ON cash_advance_repayments FOR EACH ROW EXECUTE FUNCTION ci_cross_period_failure()`);
 try{await assert.rejects(postPeriod(otherFailure));assert.deepEqual(await state(),beforeFailure);
  const a=await readLoan();assert.equal(a.paidAmount,'100000.00');assert.equal(a.settledAmount,'50000.00');}
 finally{await admin.query('DROP TRIGGER ci_cross_period_failure ON cash_advance_repayments;DROP FUNCTION ci_cross_period_failure()');}
 crossOk('failed receipt restores both prior cash and noncash totals with no partial journal');
 const raced=await initial('500000.00','100000.00','50000.00','350000.00');
 const racedResult=await Promise.all([postPeriod(raced),postPeriod(raced)]);assert.equal(racedResult.filter(r=>!r.reused).length,1);
 const racedLoan=await readLoan();assert.equal(racedLoan.paidAmount,'100000.00');assert.equal(racedLoan.settledAmount,'150000.00');assert.equal(racedLoan.remainingAmount,'250000.00');
 crossOk('concurrent requests produce exactly one noncash deduction');
 assert.equal(passed,crossPreviousCount);assert.equal(outsideQueries,0);
 console.log('KASBON_CROSS_PERIOD_POSTGRES_PASS',crossChecks,'LIVE_DATABASE_USED',false,'CASH_PAYMENT_CHANGED',false);
}
