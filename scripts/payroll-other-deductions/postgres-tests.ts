 // Additional cases in the EXISTING packaged-native PostgreSQL fixture only.
 // No live schema/role/credential/HTTP/session is touched by these tests.
 const previousCaseCount=passed;
 let otherChecks=0;
 const otherOk=(name:string)=>{otherChecks++;console.log('PASS OTHER_DEDUCTION',name);};
 const scopedQueryError=(e:any)=>{for(let i=0;i<5&&e;i++,e=e.cause)if(e.code==='42501')return true;return false;};
 await reset();await admin.query('DELETE FROM employees WHERE id BETWEEN 102 AND 117');
 await admin.query(`INSERT INTO chart_of_accounts(id,company_id,code,name,type,account_type,is_active,is_postable,is_header,status)
 VALUES(15,1,'SYNTH-OTHER-15','Synthetic other liability','liability','liability',true,true,false,'ACTIVE'),
 (16,2,'SYNTH-OTHER-FOREIGN','Synthetic foreign liability','liability','liability',true,true,false,'ACTIVE'),
 (17,1,'SYNTH-OTHER-17','Synthetic other alternative','liability','liability',true,true,false,'ACTIVE')`);
 const putMapping=()=>admin.query(`INSERT INTO payroll_coa_mappings(id,company_id,component,account_id,created_by,updated_by)
 VALUES(1001,1,'other_deduction',15,'synthetic-only','synthetic-only')`);
 async function otherFixture(value='1.00'){
  await reset();await admin.query('DELETE FROM payroll_coa_mappings');
  await admin.query("UPDATE chart_of_accounts SET type='liability',account_type='liability',is_active=true,is_postable=true,is_header=false,status='ACTIVE' WHERE id=15");
  const f=fixture();const cents=BigInt(value.replace('.',''));
  const money=(v:bigint)=>`${v/100n}.${(v%100n).toString().padStart(2,'0')}`;
  f.items=f.items.map(i=>({...i,otherDeductions:value,totalDeductions:money(30000000n+cents),netSalary:money(490000000n-cents)}));sign(f);
  await admin.query('UPDATE payroll_items SET other_deductions=$1,total_deductions=$2,net_salary=$3 WHERE id=11',
   [value,f.items[0]!.totalDeductions,f.items[0]!.netSalary]);
  await admin.query('UPDATE payroll_runs SET notes=$1 WHERE id=32',[f.run.notes]);
  await putMapping();return f;
 }
 const postOther=(f:ReturnType<typeof fixture>)=>executeAtomic(1,patched.PayrollJournalService,f);
 for(const amount of ['0.01','1.00','150000.50','4900000.00']){
  const f=await otherFixture(amount);const posted=await postOther(f);
  const journal=(await admin.query('SELECT total_debit::text,total_credit::text FROM accounting_entries WHERE id=$1',[posted.entryId])).rows[0];
  assert.deepEqual(journal,{total_debit:'5200000.00',total_credit:'5200000.00'});
  const line=(await admin.query('SELECT account_id,debit::text,credit::text FROM accounting_entry_lines WHERE entry_id=$1 AND account_id=15',[posted.entryId])).rows;
  assert.deepEqual(line,[{account_id:15,debit:'0.00',credit:amount}]);
  const ledger=(await admin.query("SELECT account_id,debit::text,credit::text FROM fleet_ledger_entries WHERE company_id=1 AND source_type='payroll' AND source_id=32 AND account_id=15")).rows;
  assert.deepEqual(ledger,line);
  const data=await state();assert.equal(data.entries,1);assert.equal(data.audit,1);assert.equal(data.outbox,1);
  assert.equal(data.balance,'400000.00');assert.equal(data.repayments,1);assert.equal(data.payments,0);assert.equal(outsideQueries,0);
  const approval=(await admin.query('SELECT approved_at,notes FROM payroll_runs WHERE id=32')).rows[0];
  assert.equal(approval.notes,f.run.notes);assert.equal(new Date(approval.approved_at).toISOString(),new Date(f.run.approvedAt!).toISOString());
  otherOk('actual packaged engine posts exact mapped credit '+amount+' with balanced ledger and unchanged approval');
 }
 const replayFixture=await otherFixture('150000.50');const firstOther=await postOther(replayFixture);const firstState=await state();
 const repeatOther=await postOther(replayFixture);assert.equal(repeatOther.reused,true);assert.equal(repeatOther.entryId,firstOther.entryId);assert.deepEqual(await state(),firstState);
 otherOk('replay creates no additional other-deduction credit or kasbon repayment');
 const parallelFixture=await otherFixture();const pairOther=await Promise.all([postOther(parallelFixture),postOther(parallelFixture)]);
 assert.equal(pairOther.filter(r=>!r.reused).length,1);assert.equal(pairOther[0].entryId,pairOther[1].entryId);
 assert.equal((await state()).entries,1);assert.equal((await state()).repayments,1);otherOk('concurrent requests post only once');
 const missingOther=await otherFixture();await admin.query('DELETE FROM payroll_coa_mappings');
 await assert.rejects(postOther(missingOther),/OTHER_DEDUCTION_MAPPING_REQUIRED/);await unchanged();
 assert.equal((await admin.query('SELECT other_deductions::text FROM payroll_items WHERE id=11')).rows[0].other_deductions,'1.00');
 otherOk('missing mapping is denied without zeroing or redirecting the deduction');
 const foreignMapping=await otherFixture();await admin.query('UPDATE payroll_coa_mappings SET company_id=2');
 await assert.rejects(postOther(foreignMapping),/OTHER_DEDUCTION_MAPPING_REQUIRED/);await unchanged();otherOk('foreign-company mapping is invisible and never reused');
 const foreignAccount=await otherFixture();await admin.query('UPDATE payroll_coa_mappings SET account_id=16');
 await assert.rejects(postOther(foreignAccount),/OTHER_DEDUCTION_MAPPING_REQUIRED/);await unchanged();otherOk('foreign-company mapped account is rejected');
 for(const mutation of ["is_active=false","is_postable=false","is_header=true","status='INACTIVE'","type='asset'","account_type='other'"]){
  const f=await otherFixture();await admin.query('UPDATE chart_of_accounts SET '+mutation+' WHERE id=15');
  await assert.rejects(postOther(f),/OTHER_DEDUCTION_MAPPING_REQUIRED/);await unchanged();otherOk('unusable mapped COA '+mutation+' rejected before any posting');
 }
 const noPrivilege=await otherFixture();await admin.query('REVOKE SELECT ON payroll_coa_mappings FROM bizportal_payroll_settlement_dev');
 try{await assert.rejects(postOther(noPrivilege),scopedQueryError);await unchanged();}
 finally{await admin.query('GRANT SELECT ON payroll_coa_mappings TO bizportal_payroll_settlement_dev');}
 otherOk('missing optional mapping SELECT permission fails closed, no general pool fallback');
 const changedMapping=await otherFixture();await postOther(changedMapping);const postedState=await state();
 await admin.query('UPDATE payroll_coa_mappings SET account_id=17');
 await assert.rejects(postOther(changedMapping),/JOURNAL_LINES_CHANGED/);assert.deepEqual(await state(),postedState);
 otherOk('mapping change after posting refuses replay rather than reposting');
 const changedAmount=await otherFixture();await admin.query('UPDATE payroll_items SET other_deductions=2,total_deductions=300002,net_salary=4899998 WHERE id=11');
 await assert.rejects(postOther(changedAmount),/APPROVED_ITEMS_CHANGED/);await unchanged();otherOk('deduction change after approval is detected by original digest');
 const immutableMapping=await otherFixture();const lockedClient=await writer!.connect();
 try{
  await lockedClient.query('BEGIN');await lockedClient.query("SELECT set_config('app.payroll_company_id','1',true)");
  assert.equal((await lockedClient.query('SELECT id FROM payroll_coa_mappings FOR SHARE')).rows.length,1);
  await assert.rejects(lockedClient.query('UPDATE payroll_coa_mappings SET id=id WHERE id=1001'),scopedQueryError);
 }finally{await lockedClient.query('ROLLBACK');lockedClient.release();}
 await unchanged();otherOk('settlement identity can lock but cannot alter configured mapping');
 const noPeriod=await otherFixture();await admin.query('UPDATE financial_periods SET is_closed=true');
 await assert.rejects(postOther(noPeriod),/POSTING_PERIOD_CLOSED/);await unchanged();otherOk('nonzero mapped deduction does not bypass closed period');
 // Zero amount preserves the old behavior even when no mapping was configured.
 await reset();await admin.query('DELETE FROM payroll_coa_mappings');await executeAtomic();
 assert.equal((await state()).lines,6);assert.equal((await admin.query('SELECT count(*)::int n FROM accounting_entry_lines WHERE account_id=15')).rows[0].n,0);
 otherOk('zero-other Payroll keeps the original six-line journal without a new mapping');
 // Full roster uses actual database-loaded numbers, not supplied line totals.
 const multiOther=await otherFixture();const firstMappedItem=multiOther.items[0]!;
 multiOther.items=Array.from({length:17},(_,n)=>({...firstMappedItem,id:11+n,employeeId:101+n,
  kasbonDeduction:'0.00',otherDeductions:'1.00',totalDeductions:'200001.00',netSalary:'4999999.00'}));
 multiOther.activeEmployeeIds=multiOther.items.map(i=>i.employeeId);multiOther.reservations=[];sign(multiOther);
 await admin.query('DELETE FROM payroll_kasbon_auto_reservations;DELETE FROM payroll_items WHERE run_id=32');
 for(const i of multiOther.items){
  if(i.employeeId!==101)await admin.query("INSERT INTO employees(id,company_id,status) VALUES($1,1,'active')",[i.employeeId]);
  await admin.query('INSERT INTO payroll_items(id,run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,total_deductions,net_salary,is_paid) VALUES($1,32,$2,5000000,200000,5200000,100000,50000,50000,1,0,200001,4999999,false)',[i.id,i.employeeId]);
 }
 await admin.query('UPDATE payroll_runs SET notes=$1 WHERE id=32',[multiOther.run.notes]);
 const allMapped=await postOther(multiOther);
 assert.deepEqual((await admin.query('SELECT total_debit::text,total_credit::text FROM accounting_entries WHERE id=$1',[allMapped.entryId])).rows[0],{total_debit:'88400000.00',total_credit:'88400000.00'});
 assert.deepEqual((await admin.query('SELECT debit::text,credit::text FROM accounting_entry_lines WHERE entry_id=$1 AND account_id=15',[allMapped.entryId])).rows,[{debit:'0.00',credit:'17.00'}]);
 assert.equal((await state()).repayments,0);assert.equal((await state()).payments,0);assert.equal((await postOther(multiOther)).reused,true);
 otherOk('all 17 employees with nonzero other deductions post one balanced accrual and replay once');
 assert.equal(passed,previousCaseCount);
 console.log('MAPPED_OTHER_DEDUCTION_POSTGRES_PASS',otherChecks,'LIVE_DATABASE_USED',false,'SALARY_PAYMENT_SENT',false);
