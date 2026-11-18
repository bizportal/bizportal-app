// Test orchestration only, not mounted in the application. Financial journal
// and line INSERTs are executed by the existing legacy writer, not this file.
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import * as schema from '__ROOT__/lib/db/src/schema/accounting.ts';

const admin=new Pool({connectionString:process.env.PAYROLL_PG_E2E_URL!,max:3});
let writer:Pool|undefined;
let passed=0;
const ok=(name:string)=>{passed++;console.log('PASS',name);};
const dialect=new PgDialect();
const globalDb=drizzle(admin);
let outsideQueries=0;
(globalThis as any).__nativePayrollDb=new Proxy(globalDb,{get(target,key){
 const value=Reflect.get(target,key);
 return typeof value==='function'?(...args:unknown[])=>{outsideQueries++;return value.apply(target,args);}:value;
}});
const original=await import('__BASE__');
const patched=await import('__FIXED__');
const tables=[schema.chartOfAccountsTable,schema.accountingJournalsTable,schema.accountingEntriesTable,schema.accountingEntryLinesTable];
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const text=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const createdEnums=new Set<string>();
async function createFixtureTable(table:any){
 const t=getTableConfig(table),fields=[];
 for(const col of t.columns as any[]){
  const typ=col.getSQLType();
  if(col.columnType==='PgEnumColumn'&&!createdEnums.has(typ)){
   await admin.query('CREATE TYPE '+quote(typ)+' AS ENUM('+col.enumValues.map(text).join(',')+')');createdEnums.add(typ);
  }
  let def='';
  if(col.default!==undefined){
   if(typeof col.default==='string')def=' DEFAULT '+text(col.default);
   else if(typeof col.default==='number'||typeof col.default==='boolean')def=' DEFAULT '+String(col.default);
   else def=' DEFAULT '+dialect.sqlToQuery(col.default).sql;
  }
  fields.push(quote(col.name)+' '+typ+def+(col.notNull?' NOT NULL':'')+(col.primary?' PRIMARY KEY':''));
 }
 await admin.query('CREATE TABLE '+quote(t.name)+'('+fields.join(',')+')');
}
async function reset(){
 await admin.query('TRUNCATE accounting_entry_lines,accounting_entries,ledger_events,financial_outbox_events,payroll_runs,payroll_items,cash_advances,payroll_kasbon_auto_reservations,journal_sequences,salary_payments RESTART IDENTITY');
 const f=fixture();
 await admin.query("INSERT INTO payroll_runs(id,company_id,year,month,status,posting_status,approved_at,notes) VALUES(32,1,2026,11,'reviewed','pending',$1,$2),(33,2,2026,11,'reviewed','pending',$1,'other company')",[f.run.approvedAt,f.run.notes]);
 const i=f.items[0]!;
 await admin.query('INSERT INTO payroll_items(id,run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,total_deductions,net_salary,is_paid) VALUES(11,32,101,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)',[i.baseSalary,i.allowance,i.grossSalary,i.bpjsJhtEmployee,i.bpjsKesEmployee,i.pph21,i.otherDeductions,i.kasbonDeduction,i.totalDeductions,i.netSalary]);
 await admin.query("INSERT INTO cash_advances(id,company_id,employee_id,remaining_amount,settled_amount) VALUES(801,1,101,500000,0)");
 await admin.query("INSERT INTO payroll_kasbon_auto_reservations(id,company_id,run_id,advance_id,payroll_item_id,employee_id,amount,balance_at_preparation,state) VALUES(501,1,32,801,11,101,100000,500000,'prepared')");
 await admin.query('UPDATE financial_periods SET is_closed=false');
 outsideQueries=0;
}
async function state(){
 const counts=(await admin.query(`SELECT
 (SELECT count(*)::int FROM accounting_entries) entries,
 (SELECT count(*)::int FROM accounting_entry_lines) lines,
 (SELECT count(*)::int FROM ledger_events) audit,
 (SELECT count(*)::int FROM financial_outbox_events) outbox,
 (SELECT remaining_amount::text FROM cash_advances WHERE id=801) balance,
 (SELECT state FROM payroll_kasbon_auto_reservations WHERE id=501) reservation,
 (SELECT status FROM payroll_runs WHERE id=32) status,
 (SELECT accounting_entry_id FROM payroll_runs WHERE id=32) entry_id,
 (SELECT count(*)::int FROM salary_payments) payments`)).rows[0];
 return counts;
}
async function unchanged(){
 const s=await state();assert.deepEqual(s,{entries:0,lines:0,audit:0,outbox:0,balance:'500000.00',reservation:'prepared',status:'reviewed',entry_id:null,payments:0});assert.equal(outsideQueries,0);
}
const fixtureInput=fixture();
async function executeAtomic(companyId=1,failure=''){
 const db=drizzle(writer!);
 return db.transaction(async(tx)=>{
  await tx.execute(sql`SELECT set_config('app.payroll_company_id',${String(companyId)},true)`);
  const identity:any=await tx.execute(sql`SELECT current_user AS name`);assert.equal(identity.rows[0].name,'ci_payroll_atomic');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${companyId}::integer,32::integer)`);
  const result:any=await tx.execute(sql`SELECT * FROM payroll_runs WHERE id=32 AND company_id=${companyId} FOR UPDATE`);
  if(result.rows.length!==1)throw Error('FOREIGN_OR_MISSING_RUN');
  const r=result.rows[0];
  const lineRows:any=await tx.execute(sql`SELECT * FROM payroll_items WHERE run_id=32 ORDER BY id FOR UPDATE`);
  const items=lineRows.rows.map((x:any)=>({id:x.id,employeeId:x.employee_id,baseSalary:x.base_salary,allowance:x.allowance,grossSalary:x.gross_salary,bpjsJhtEmployee:x.bpjs_jht_employee,bpjsKesEmployee:x.bpjs_kes_employee,pph21:x.pph21,otherDeductions:x.other_deductions,kasbonDeduction:x.kasbon_deduction,totalDeductions:x.total_deductions,netSalary:x.net_salary,isPaid:x.is_paid}));
  const active:any=await tx.execute(sql`SELECT id FROM employees WHERE company_id=${companyId} AND status='active' ORDER BY id FOR SHARE`);
  // Replay verifies persisted source, totals, receipt and reservation state;
  // it does not repeat a deduction or manufacture a fresh approval.
  if(r.status==='approved'){
   const receipt=JSON.parse(String(r.notes).split(PAYROLL_SUPER_ADMIN_APPROVAL_MARKER+' ')[1]);
   const digest=payrollSuperAdminApprovalDigest(companyId,32,items.map(({isPaid,...i}:any)=>i));
   if(receipt.digest!==digest)throw Error('REPLAY_DIGEST_CHANGED');
   const journal:any=await tx.execute(sql`SELECT * FROM accounting_entries WHERE id=${r.accounting_entry_id} AND company_id=${companyId} AND source='payroll' AND source_id=32 AND ref='PAYROLL-32' AND status='posted' FOR SHARE`);
   const verified=journal.rows[0];
   if(!verified||verified.total_debit!=='5200000.00'||verified.total_credit!=='5200000.00')throw Error('REPLAY_JOURNAL_NOT_VERIFIED');
   const confirmed:any=await tx.execute(sql`SELECT id FROM payroll_kasbon_auto_reservations WHERE run_id=32 AND company_id=${companyId} AND state='confirmed'`);
   if(confirmed.rows.length!==1)throw Error('REPLAY_RESERVATION_NOT_CONFIRMED');
   return {entryId:verified.id,reused:true};
  }
  const hold:any=await tx.execute(sql`SELECT r.*,a.remaining_amount FROM payroll_kasbon_auto_reservations r JOIN cash_advances a ON a.id=r.advance_id AND a.company_id=r.company_id WHERE r.run_id=32 AND r.company_id=${companyId} ORDER BY r.id FOR UPDATE OF r,a`);
  const input=fixture();
  input.run={...input.run,status:r.status,postingStatus:r.posting_status,approvedAt:r.approved_at,notes:r.notes,accountingEntryId:r.accounting_entry_id,paymentEntryId:r.payment_entry_id};
  input.items=items;input.activeEmployeeIds=active.rows.map((x:any)=>x.id);
  input.reservations=hold.rows.map((h:any)=>({...fixtureInput.reservations[0]!,companyId:h.company_id,runId:h.run_id,advanceId:h.advance_id,payrollItemId:h.payroll_item_id,employeeId:h.employee_id,amount:h.amount,heldBalance:h.balance_at_preparation,currentBalance:h.remaining_amount,state:h.state}));
  const accounts:any=await tx.execute(sql`SELECT id,company_id,type,is_active,is_postable,is_header,status FROM chart_of_accounts WHERE company_id=${companyId} ORDER BY id FOR SHARE`);
  input.accounts=accounts.rows.map((a:any)=>({id:a.id,companyId:a.company_id,type:a.type,isActive:a.is_active,isPostable:a.is_postable,isHeader:a.is_header,status:a.status}));
  const plan=prepareReviewedPayrollAccrual(input);
  const entry=await patched.PayrollJournalService.postAccrualJournal(plan.mapping,plan.params,tx);
  if(failure==='after_journal')throw Error('INJECTED_AFTER_JOURNAL');
  // Real persisted journal readback, not the writer's returned claim alone.
  const verify:any=await tx.execute(sql`SELECT company_id,source,source_id,status,total_debit,total_credit FROM accounting_entries WHERE id=${entry.entryId}`);
  assert.deepEqual(verify.rows[0],{company_id:companyId,source:'payroll',source_id:32,status:'posted',total_debit:plan.debitTotal,total_credit:plan.creditTotal});
  for(const h of hold.rows){
   const settlement:any=await tx.execute(sql`UPDATE cash_advances SET remaining_amount=remaining_amount-${h.amount}::numeric,settled_amount=settled_amount+${h.amount}::numeric WHERE id=${h.advance_id} AND company_id=${companyId} AND remaining_amount=${h.balance_at_preparation}::numeric RETURNING id`);
   assert.equal(settlement.rows.length,1);
   const confirm:any=await tx.execute(sql`UPDATE payroll_kasbon_auto_reservations SET state='confirmed' WHERE id=${h.id} AND company_id=${companyId} AND state='prepared' RETURNING id`);
   assert.equal(confirm.rows.length,1);
  }
  if(failure==='after_kasbon')throw Error('INJECTED_AFTER_KASBON');
  const update:any=await tx.execute(sql`UPDATE payroll_runs SET status='approved',posting_status='posted',accounting_entry_id=${entry.entryId} WHERE id=32 AND company_id=${companyId} AND status='reviewed' AND accounting_entry_id IS NULL RETURNING approved_at,notes`);
  assert.equal(update.rows.length,1);assert.equal(new Date(update.rows[0].approved_at).toISOString(),new Date(fixtureInput.run.approvedAt!).toISOString());assert.equal(update.rows[0].notes,fixtureInput.run.notes);
  if(failure==='after_payroll')throw Error('INJECTED_AFTER_PAYROLL');
  return {entryId:entry.entryId,reused:false};
 });
}
try{
 const version=(await admin.query('SHOW server_version')).rows[0].server_version;
 assert.match(version,/^16\./);console.log('POSTGRES',version,'FIXTURE_ONLY',true);
 for(const table of tables)await createFixtureTable(table);
 await admin.query(`ALTER TABLE accounting_entries ADD COLUMN checksum_hash text, ADD COLUMN previous_entry_id integer;
 CREATE UNIQUE INDEX ci_source_company ON accounting_entries(company_id,source,source_id);
 CREATE TABLE journal_sequences(journal_prefix text,company_id integer,year integer,next_seq integer,PRIMARY KEY(journal_prefix,company_id,year));
 CREATE TABLE financial_periods(company_id integer,year integer,month integer,is_closed boolean,override_allowed boolean);
 CREATE TABLE ledger_events(id serial PRIMARY KEY,company_id integer,event_type text,period text,entry_id integer,ledger_entry_id bigint,actor text,payload jsonb);
 CREATE TABLE financial_outbox_events(id serial PRIMARY KEY,event_type text,payload jsonb,entry_id integer,company_id integer);
 CREATE TABLE payroll_runs(id integer PRIMARY KEY,company_id integer,year integer,month integer,status text,posting_status text,approved_at timestamptz,notes text,accounting_entry_id integer,payment_entry_id integer);
 CREATE TABLE employees(id integer PRIMARY KEY,company_id integer,status text);
 CREATE TABLE payroll_items(id integer PRIMARY KEY,run_id integer,employee_id integer,base_salary numeric(16,2),allowance numeric(16,2),gross_salary numeric(16,2),bpjs_jht_employee numeric(16,2),bpjs_kes_employee numeric(16,2),pph21 numeric(16,2),other_deductions numeric(16,2),kasbon_deduction numeric(16,2),total_deductions numeric(16,2),net_salary numeric(16,2),is_paid boolean);
 CREATE TABLE cash_advances(id integer PRIMARY KEY,company_id integer,employee_id integer,remaining_amount numeric(16,2),settled_amount numeric(16,2));
 CREATE TABLE payroll_kasbon_auto_reservations(id integer PRIMARY KEY,company_id integer,run_id integer,advance_id integer,payroll_item_id integer,employee_id integer,amount numeric(16,2),balance_at_preparation numeric(16,2),state text);
 CREATE TABLE salary_payments(id serial PRIMARY KEY);
 INSERT INTO employees VALUES(101,1,'active'),(201,2,'active');
 INSERT INTO financial_periods VALUES(1,2026,11,false,false);
 INSERT INTO accounting_journals(id,company_id,code,name,type) VALUES(701,1,'GENERAL','Synthetic General','general');
 CREATE ROLE ci_payroll_atomic LOGIN PASSWORD 'disposable-ci-only' NOSUPERUSER NOBYPASSRLS;
 GRANT USAGE ON SCHEMA public TO ci_payroll_atomic;
 GRANT SELECT,INSERT,UPDATE ON accounting_entries,accounting_entry_lines,journal_sequences,ledger_events,financial_outbox_events TO ci_payroll_atomic;
 GRANT SELECT ON employees,chart_of_accounts,accounting_journals,financial_periods,payroll_items TO ci_payroll_atomic;
 GRANT UPDATE(id) ON employees,chart_of_accounts,payroll_items TO ci_payroll_atomic;
 GRANT SELECT,UPDATE ON payroll_runs,cash_advances,payroll_kasbon_auto_reservations TO ci_payroll_atomic;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ci_payroll_atomic;`);
 for(const a of fixtureInput.accounts)await admin.query('INSERT INTO chart_of_accounts(id,company_id,code,name,type,is_active,is_postable,is_header,status) VALUES($1,1,$2,$3,$4,true,true,false,$5)',[a.id,'SYNTH-'+a.id,'Synthetic '+a.type,a.type,a.status]);
 for(const table of ['accounting_entries','journal_sequences','ledger_events','financial_outbox_events','payroll_runs','cash_advances','payroll_kasbon_auto_reservations','employees','chart_of_accounts','accounting_journals','financial_periods']){
  await admin.query(`ALTER TABLE ${quote(table)} ENABLE ROW LEVEL SECURITY; CREATE POLICY ci_scope ON ${quote(table)} TO ci_payroll_atomic USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer) WITH CHECK(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)`);
 }
 for(const [table,parent,key] of [['accounting_entry_lines','accounting_entries','entry_id'],['payroll_items','payroll_runs','run_id']]){
  await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; CREATE POLICY ci_scope ON ${table} TO ci_payroll_atomic USING(EXISTS(SELECT 1 FROM ${parent} r WHERE r.id=${table}.${key} AND r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)) WITH CHECK(EXISTS(SELECT 1 FROM ${parent} r WHERE r.id=${table}.${key} AND r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer))`);
 }
 const login=new URL(process.env.PAYROLL_PG_E2E_URL!);login.username='ci_payroll_atomic';login.password='disposable-ci-only';writer=new Pool({connectionString:login.href,max:4});
 await reset();
 const plan=prepareReviewedPayrollAccrual(fixture());
 // Baseline: the native old writer creates global audit/outbox even though
 // the caller's financial transaction later rolls back.
 await assert.rejects(globalDb.transaction(async tx=>{
  await original.postEntryWithClient(tx,{journalId:701,date:new Date('2026-11-17T00:00:00Z'),companyId:1,source:'payroll',sourceId:32,ref:'PAYROLL-32',lines:[{accountId:10,debit:5200000,credit:0},{accountId:11,debit:0,credit:5200000}]},'GENERAL');
  throw Error('BASELINE_ROLLBACK');
 }),/BASELINE_ROLLBACK/);
 await new Promise(r=>setTimeout(r,150));
 const baseline=await state();assert.equal(baseline.entries,0);assert.ok(baseline.audit>0);assert.ok(baseline.outbox>0);
 console.log('BASELINE_REPRODUCED','journal_rolled_back_but_external_audit_and_outbox_remained');ok('baseline regression reproduced on actual PostgreSQL');
 await reset();
 const result=await executeAtomic();assert.equal(result.reused,false);
 const success=await state();assert.deepEqual(success,{entries:1,lines:6,audit:1,outbox:1,balance:'400000.00',reservation:'confirmed',status:'approved',entry_id:result.entryId,payments:0});assert.equal(outsideQueries,0);ok('existing native writer commits journal, audit, outbox, kasbon and payroll together under restricted role');
 const replay=await executeAtomic();assert.equal(replay.entryId,result.entryId);assert.equal(replay.reused,true);assert.deepEqual(await state(),success);ok('replay reuses same verified journal without duplicate kasbon');
 for(const stage of ['after_journal','after_kasbon','after_payroll']){
  await reset();await assert.rejects(executeAtomic(1,stage),/INJECTED_/);await unchanged();ok('rollback '+stage+' leaves zero journal/lines/audit/outbox and preserves balance');
 }
 await reset();const concurrent=await Promise.all([executeAtomic(),executeAtomic()]);assert.equal(concurrent.filter(x=>!x.reused).length,1);assert.equal(concurrent[0].entryId,concurrent[1].entryId);assert.equal((await state()).balance,'400000.00');assert.equal((await state()).entries,1);assert.equal((await state()).outbox,1);ok('concurrent calls serialize to one accrual and one deduction');
 await reset();await assert.rejects(executeAtomic(2),/FOREIGN_OR_MISSING_RUN/);await unchanged();ok('RLS rejects foreign company before mutation');
 await reset();await admin.query('UPDATE financial_periods SET is_closed=true');await assert.rejects(executeAtomic(),/PERIOD_CLOSED/);await unchanged();ok('closed posting period rolls back without global fallback');
 await reset();await admin.query('UPDATE payroll_items SET base_salary=5000001,gross_salary=5200001,net_salary=4900001 WHERE id=11');await assert.rejects(executeAtomic(),/APPROVED_DATA_CHANGED/);await unchanged();ok('salary changed after approval is rejected');
 await reset();await admin.query("UPDATE cash_advances SET remaining_amount=499999 WHERE id=801");await assert.rejects(executeAtomic(),/KASBON_RESERVATIONS_INVALID/);assert.equal((await state()).entries,0);assert.equal((await state()).balance,'499999.00');ok('changed kasbon balance is rejected before posting');
 await reset();await admin.query(`CREATE FUNCTION ci_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_OUTBOX_FAILURE'; END $$; CREATE TRIGGER ci_outbox_failure BEFORE INSERT ON financial_outbox_events FOR EACH ROW EXECUTE FUNCTION ci_outbox_failure()`);
 await assert.rejects(executeAtomic());await unchanged();await admin.query('DROP TRIGGER ci_outbox_failure ON financial_outbox_events; DROP FUNCTION ci_outbox_failure()');ok('outbox failure aborts financial posting instead of silently leaving partial state');
 for(const table of ['ledger_events','journal_sequences']){
  await reset();
  await admin.query(`CREATE FUNCTION ci_atomic_dependency_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_DEPENDENCY_FAILURE'; END $$; CREATE TRIGGER ci_atomic_dependency_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ci_atomic_dependency_failure()`);
  await assert.rejects(executeAtomic());await unchanged();
  await admin.query(`DROP TRIGGER ci_atomic_dependency_failure ON ${table}; DROP FUNCTION ci_atomic_dependency_failure()`);
  ok(table+' failure aborts posting without external recovery or leftover writes');
 }
 await reset();await executeAtomic();await admin.query("UPDATE accounting_entries SET status='draft'");await assert.rejects(executeAtomic(),/REPLAY_JOURNAL_NOT_VERIFIED/);assert.equal((await state()).balance,'400000.00');ok('replay refuses non-posted journal without double deduction');
 console.log('REAL_POSTGRES_CHECKS_PASS',passed,'LIVE_CST_DEV_OR_PROD_USED',false,'BANK_TRANSFER_SENT',false);
}finally{if(writer)await writer.end();await admin.end();}
