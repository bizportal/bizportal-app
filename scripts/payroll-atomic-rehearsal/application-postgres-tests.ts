// Disposable PostgreSQL contract suite for the actual APPLICATION transaction
// service. The service loads locked rows; no financial orchestration is mocked.
import assert from 'node:assert/strict';
import {postReviewedPayrollAccrualTransaction} from '__ROOT__/artifacts/api-server/src/routes/payroll-accounting-transaction.ts';
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
const tables=[schema.chartOfAccountsTable,schema.accountingJournalsTable,schema.accountingEntriesTable,schema.accountingEntryLinesTable,schema.accountingSettingsTable];
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
 await admin.query('TRUNCATE cash_advance_installment_schedules,payroll_cash_advance_allocations,fleet_ledger_entries,accounting_entry_lines,accounting_entries,ledger_events,financial_outbox_events,payroll_runs,payroll_items,cash_advances,payroll_kasbon_auto_reservations,journal_sequences,salary_payments,cash_advance_repayments RESTART IDENTITY');
 const f=fixture();
 await admin.query("INSERT INTO payroll_runs(id,company_id,year,month,status,posting_status,approved_at,notes) VALUES(32,1,2026,11,'draft','pending',$1,$2),(33,2,2026,11,'reviewed','pending',$1,'other company')",[f.run.approvedAt,f.run.notes]);
 const i=f.items[0]!;
 await admin.query('INSERT INTO payroll_items(id,run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,total_deductions,net_salary,is_paid) VALUES(11,32,101,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)',[i.baseSalary,i.allowance,i.grossSalary,i.bpjsJhtEmployee,i.bpjsKesEmployee,i.pph21,i.otherDeductions,i.kasbonDeduction,i.totalDeductions,i.netSalary]);
 await admin.query("UPDATE payroll_runs SET status='reviewed' WHERE id=32");
 await admin.query("INSERT INTO cash_advances(id,company_id,employee_id,type,currency,amount,paid_amount,remaining_amount,settled_amount,receivable_account_id,status,lifecycle_status,approved_at,approved_by,disbursed_at,disbursed_by,accounting_entry_id,posting_status) VALUES(801,1,101,'kasbon','IDR',500000,0,500000,0,14,'active','outstanding','2026-10-01','synthetic','2026-10-02','synthetic',91,'posted')");
 await admin.query("INSERT INTO payroll_kasbon_auto_reservations(id,company_id,run_id,advance_id,payroll_item_id,employee_id,amount,balance_at_preparation,state,period) VALUES(501,1,32,801,11,101,100000,500000,'prepared','2026-11-01')");
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
 (SELECT count(*)::int FROM salary_payments) payments,
 (SELECT count(*)::int FROM cash_advance_repayments) repayments`)).rows[0];
 return counts;
}
async function unchanged(){
 const s=await state();assert.deepEqual(s,{entries:0,lines:0,audit:0,outbox:0,balance:'500000.00',reservation:'prepared',status:'reviewed',entry_id:null,payments:0,repayments:0});assert.equal(outsideQueries,0);
}
const fixtureInput=fixture();
async function executeAtomic(companyId=1, native=patched.PayrollJournalService, approvedFixture=fixtureInput){
 process.env.APP_ENV='development';process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='true';
 const receipt=JSON.parse(approvedFixture.run.notes!.split(PAYROLL_SUPER_ADMIN_APPROVAL_MARKER+' ')[1]);
 return postReviewedPayrollAccrualTransaction(writer!, native, {
  companyId,runId:32,postingDate:'2026-11-17',expectedDigest:receipt.digest,
  actor:{id:receipt.actorId,email:receipt.actorEmail,role:'super_admin'},
 });
}
async function injectedFailure(table:string,timing:string,event:string,fn:()=>Promise<unknown>){
 await admin.query(`CREATE FUNCTION ci_application_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_APPLICATION_FAILURE'; END $$;
 CREATE TRIGGER ci_application_failure ${timing} ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ci_application_failure()`);
 try{await assert.rejects(fn());await unchanged();}
 finally{await admin.query(`DROP TRIGGER ci_application_failure ON ${table}; DROP FUNCTION ci_application_failure()`);}
}

try{
 const version=(await admin.query('SHOW server_version')).rows[0].server_version;
 assert.match(version,/^16\./);console.log('POSTGRES',version,'FIXTURE_ONLY',true);
 for(const table of tables)await createFixtureTable(table);
 await admin.query(`ALTER TABLE accounting_entries ADD COLUMN checksum_hash text, ADD COLUMN previous_entry_id integer;
 CREATE UNIQUE INDEX ci_source_company ON accounting_entries(company_id,source,source_id);
 CREATE TABLE journal_sequences(journal_prefix text,company_id integer,year integer,next_seq integer,PRIMARY KEY(journal_prefix,company_id,year));
 -- Actual CST-DEV has this legacy account_type field in addition to type;
 -- the canonical Drizzle schema omits it. Model that inspected column explicitly.
 ALTER TABLE chart_of_accounts ADD COLUMN account_type text;
 CREATE TABLE financial_periods(company_id integer,year integer,month integer,is_closed boolean,override_allowed boolean);
 CREATE TABLE ledger_events(id serial PRIMARY KEY,company_id integer,event_type text,period text,entry_id integer,ledger_entry_id bigint,actor text,payload jsonb);
 CREATE TABLE financial_outbox_events(id serial PRIMARY KEY,event_type text,payload jsonb,entry_id integer,company_id integer);
 CREATE TABLE payroll_runs(id integer PRIMARY KEY,company_id integer,year integer,month integer,status text,posting_status text,approved_at timestamp,notes text,accounting_entry_id integer,payment_entry_id integer,posted_at timestamp,posting_error text,posting_claimed_at timestamp);
 CREATE TABLE employees(id integer PRIMARY KEY,company_id integer,status text,deleted_at timestamptz);
 CREATE TABLE payroll_items(id integer PRIMARY KEY,run_id integer,employee_id integer,base_salary numeric(16,2),allowance numeric(16,2),gross_salary numeric(16,2),bpjs_jht_employee numeric(16,2),bpjs_kes_employee numeric(16,2),pph21 numeric(16,2),other_deductions numeric(16,2),kasbon_deduction numeric(16,2),total_deductions numeric(16,2),net_salary numeric(16,2),is_paid boolean);
 CREATE TABLE cash_advances(id integer PRIMARY KEY,company_id integer,employee_id integer,type text,currency text,
 amount numeric(16,2),paid_amount numeric(16,2),remaining_amount numeric(16,2),settled_amount numeric(16,2),
 receivable_account_id integer,status text,lifecycle_status text,approved_at timestamptz,approved_by text,
 disbursed_at timestamptz,disbursed_by text,accounting_entry_id integer,posting_status text,voided_at timestamptz,
 repayment_journal_id integer,repaid_at timestamptz,updated_at timestamptz);
 CREATE TABLE cash_advance_repayments(id serial PRIMARY KEY,advance_id integer,amount numeric(16,2),payment_method text,
 date date,notes text,entry_id integer,idempotency_key text UNIQUE,posted_at timestamptz,created_by text,payment_reference text);
 CREATE TABLE cash_advance_installment_schedules(id serial PRIMARY KEY,advance_id integer,status text,
 company_id integer,installment_number integer,due_date date,amount numeric(16,2),repayment_id integer REFERENCES cash_advance_repayments(id),
 paid_date date,paid_amount numeric(16,2),accounting_entry_id integer,payroll_item_id integer,notes text,
 created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now());
 CREATE TABLE payroll_cash_advance_allocations(id serial PRIMARY KEY,payroll_item_id integer,cash_advance_id integer,amount numeric(16,2),installment_schedule_id integer,created_at timestamp NOT NULL DEFAULT now());
 CREATE TABLE payroll_kasbon_auto_reservations(id integer PRIMARY KEY,company_id integer,run_id integer,advance_id integer,payroll_item_id integer,employee_id integer,amount numeric(16,2),balance_at_preparation numeric(16,2),state text,period date,confirmed_at timestamptz,cancelled_at timestamptz,UNIQUE(company_id,run_id,advance_id));
 CREATE TABLE fleet_ledger_entries(id bigserial PRIMARY KEY,company_id integer NOT NULL,
 ledger_date date NOT NULL,period text NOT NULL,source_type text NOT NULL,source_id integer,source_ref text,
 account_id integer NOT NULL REFERENCES chart_of_accounts(id),account_code text NOT NULL,
 account_name text NOT NULL,account_type text NOT NULL,debit numeric(15,2) NOT NULL DEFAULT 0,
 credit numeric(15,2) NOT NULL DEFAULT 0,description text,cost_center_id integer,
 currency text NOT NULL DEFAULT 'IDR',is_voided boolean NOT NULL DEFAULT false,void_ref_id bigint,
 created_by text,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE payroll_coa_mappings(id bigint PRIMARY KEY,company_id integer NOT NULL,
 component text NOT NULL CHECK(component IN ('salary_expense','salary_payable','income_tax_payable','jht_payable','health_payable','other_deduction','cash_advance')),
 account_id integer NOT NULL REFERENCES chart_of_accounts(id),created_by text NOT NULL,updated_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,component));
 ALTER TABLE payroll_coa_mappings ENABLE ROW LEVEL SECURITY;
 CREATE TABLE salary_payments(id serial PRIMARY KEY);
 INSERT INTO employees(id,company_id,status) VALUES(101,1,'active'),(201,2,'active');
 INSERT INTO financial_periods VALUES(1,2026,11,false,false);
 INSERT INTO accounting_journals(id,company_id,code,name,type) VALUES(701,1,'GENERAL','Synthetic General','general');
 CREATE ROLE bizportal_payroll_settlement_dev LOGIN PASSWORD 'disposable-ci-only' NOSUPERUSER NOBYPASSRLS;
 GRANT USAGE ON SCHEMA public TO bizportal_payroll_settlement_dev;
 GRANT SELECT,INSERT,UPDATE ON accounting_entries,accounting_entry_lines,journal_sequences,ledger_events,financial_outbox_events TO bizportal_payroll_settlement_dev;
 GRANT SELECT ON employees,chart_of_accounts,accounting_journals,financial_periods,payroll_items TO bizportal_payroll_settlement_dev;
 GRANT SELECT ON payroll_coa_mappings TO bizportal_payroll_settlement_dev;
 GRANT UPDATE(id) ON payroll_coa_mappings TO bizportal_payroll_settlement_dev;
 CREATE FUNCTION ci_other_mapping_no_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF current_user='bizportal_payroll_settlement_dev' THEN RAISE EXCEPTION 'MAPPING_LOCK_ONLY' USING ERRCODE='42501'; END IF;
 RETURN NEW; END $$;
 CREATE TRIGGER ci_other_mapping_no_write BEFORE UPDATE ON payroll_coa_mappings FOR EACH ROW EXECUTE FUNCTION ci_other_mapping_no_write();
 CREATE POLICY ci_other_mapping_read ON payroll_coa_mappings FOR SELECT TO bizportal_payroll_settlement_dev
 USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
 -- PostgreSQL applies UPDATE policy visibility to SELECT FOR SHARE as well.
 -- WITH CHECK(false) plus the mutation trigger still prohibit actual changes.
 CREATE POLICY ci_other_mapping_lock ON payroll_coa_mappings FOR UPDATE TO bizportal_payroll_settlement_dev
 USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer) WITH CHECK(false);


 GRANT UPDATE(id) ON employees,chart_of_accounts,payroll_items TO bizportal_payroll_settlement_dev;
 GRANT SELECT,UPDATE ON payroll_runs,cash_advances,payroll_kasbon_auto_reservations TO bizportal_payroll_settlement_dev;
 GRANT SELECT,INSERT ON cash_advance_repayments TO bizportal_payroll_settlement_dev;
 GRANT SELECT,INSERT ON fleet_ledger_entries TO bizportal_payroll_settlement_dev;
 GRANT UPDATE(id) ON fleet_ledger_entries TO bizportal_payroll_settlement_dev;
 GRANT SELECT ON accounting_settings,payroll_cash_advance_allocations,cash_advance_installment_schedules TO bizportal_payroll_settlement_dev;
 GRANT UPDATE(id) ON accounting_settings,cash_advance_repayments TO bizportal_payroll_settlement_dev;
 GRANT UPDATE(company_id) ON financial_periods TO bizportal_payroll_settlement_dev;
 INSERT INTO accounting_settings(company_id,salary_expense_account_id,allowance_expense_account_id,salary_payable_account_id,tax_payable_account_id,bpjs_payable_account_id)
 VALUES(1,10,10,11,12,13);
 CREATE FUNCTION ci_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='reviewed' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (NEW.status='approved' AND NEW.accounting_entry_id IS NOT NULL) THEN RAISE EXCEPTION 'PAYROLL_HR_REVIEW_CANNOT_BE_REOPENED'; END IF;
 RETURN NEW; END $$;
 CREATE TRIGGER ci_review_guard BEFORE UPDATE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION ci_review_guard();
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO bizportal_payroll_settlement_dev;`);
 for(const a of fixtureInput.accounts)await admin.query('INSERT INTO chart_of_accounts(id,company_id,code,name,type,is_active,is_postable,is_header,status) VALUES($1,1,$2,$3,$4,true,true,false,$5)',[a.id,'SYNTH-'+a.id,'Synthetic '+a.type,a.type,a.status]);
 for(const table of ['accounting_entries','journal_sequences','ledger_events','financial_outbox_events','payroll_runs','cash_advances','payroll_kasbon_auto_reservations','employees','chart_of_accounts','accounting_journals','financial_periods','accounting_settings']){
  await admin.query(`ALTER TABLE ${quote(table)} ENABLE ROW LEVEL SECURITY; CREATE POLICY ci_scope ON ${quote(table)} TO bizportal_payroll_settlement_dev USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer) WITH CHECK(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)`);
 }
 for(const [table,parent,key] of [['accounting_entry_lines','accounting_entries','entry_id'],['payroll_items','payroll_runs','run_id']]){
  await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; CREATE POLICY ci_scope ON ${table} TO bizportal_payroll_settlement_dev USING(EXISTS(SELECT 1 FROM ${parent} r WHERE r.id=${table}.${key} AND r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)) WITH CHECK(EXISTS(SELECT 1 FROM ${parent} r WHERE r.id=${table}.${key} AND r.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer))`);
 }
 await admin.query(`ALTER TABLE cash_advance_repayments ENABLE ROW LEVEL SECURITY;
 CREATE POLICY ci_scope ON cash_advance_repayments TO bizportal_payroll_settlement_dev
 USING(EXISTS(SELECT 1 FROM cash_advances a WHERE a.id=cash_advance_repayments.advance_id AND a.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer))
 WITH CHECK(EXISTS(SELECT 1 FROM cash_advances a WHERE a.id=cash_advance_repayments.advance_id AND a.company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer))`);
 // Test-only scoped grant/policy for representative successful fixture; live
 // fleet ledger RLS currently has no policies. The ledger suite reproduces it.
 await admin.query("ALTER TABLE fleet_ledger_entries ENABLE ROW LEVEL SECURITY; CREATE POLICY ci_fleet_ledger_scope ON fleet_ledger_entries TO bizportal_payroll_settlement_dev USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer) WITH CHECK(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)");
 await admin.query((await import('node:fs')).readFileSync('__ROOT__/scripts/payroll-atomic-rehearsal/dev-ledger-sync.sql','utf8'));
 const ledgerContract=JSON.parse((await import('node:fs')).readFileSync('__ROOT__/scripts/payroll-atomic-rehearsal/dev-ledger-sync-provenance.json','utf8'));
 const ledgerFunctions=(await admin.query("SELECT proname,md5(pg_get_functiondef(oid)) AS hash FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])",[Object.keys(ledgerContract.liveFunctionMd5)])).rows;
 assert.equal(ledgerFunctions.length,3);
 for(const row of ledgerFunctions)assert.equal(row.hash,ledgerContract.liveFunctionMd5[row.proname],row.proname+' fixture must match inspected DEV metadata');
 console.log('LEDGER_TRIGGER_SNAPSHOT_HASHES_MATCH',3,'POLICY_AND_GRANTS','SYNTHETIC_FIXTURE_ONLY');
 const login=new URL(process.env.PAYROLL_PG_E2E_URL!);login.username='bizportal_payroll_settlement_dev';login.password='disposable-ci-only';writer=new Pool({connectionString:login.href,max:4});
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
 const success=await state();assert.deepEqual(success,{entries:1,lines:6,audit:1,outbox:1,balance:'400000.00',reservation:'confirmed',status:'approved',entry_id:result.entryId,payments:0,repayments:1});assert.equal(outsideQueries,0);
 const persisted=(await admin.query("SELECT a.paid_amount::text,a.settled_amount::text,a.status,a.lifecycle_status,c.amount::text,c.entry_id,c.idempotency_key,c.posted_at IS NOT NULL AS posted FROM cash_advances a JOIN cash_advance_repayments c ON c.advance_id=a.id WHERE a.id=801")).rows[0];
 assert.deepEqual(persisted,{paid_amount:'0.00',settled_amount:'100000.00',status:'partial',lifecycle_status:'partially_settled',amount:'100000.00',entry_id:result.entryId,idempotency_key:'PAYROLL-C1-R32-AUTO-501',posted:true});
 const approval=(await admin.query('SELECT approved_at,notes FROM payroll_runs WHERE id=32')).rows[0];
 assert.equal(new Date(approval.approved_at).toISOString(),new Date(fixtureInput.run.approvedAt!).toISOString());assert.equal(approval.notes,fixtureInput.run.notes);
 ok('APPLICATION commits noncash settlement once, preserves cash repayments, and atomically links journal, ledger and run');
 const replay=await executeAtomic();assert.equal(replay.entryId,result.entryId);assert.equal(replay.reused,true);assert.deepEqual(await state(),success);ok('APPLICATION replay verifies existing journal lines and exact repayment ledger without another deduction');
 for(const [table,timing,event] of [['cash_advances','BEFORE','UPDATE'],['cash_advance_repayments','BEFORE','INSERT'],['payroll_kasbon_auto_reservations','BEFORE','UPDATE'],['payroll_runs','AFTER','UPDATE']]){
  await reset();await injectedFailure(table,timing,event,()=>executeAtomic());ok('APPLICATION rollback on '+table+' failure leaves zero financial and audit residue');
 }
 await reset();const concurrent=await Promise.all([executeAtomic(),executeAtomic()]);assert.equal(concurrent.filter(x=>!x.reused).length,1);assert.equal(concurrent[0].entryId,concurrent[1].entryId);assert.equal((await state()).balance,'400000.00');assert.equal((await state()).entries,1);assert.equal((await state()).repayments,1);ok('APPLICATION concurrent calls create one journal and one repayment with bounded serialization retry');
 await reset();await assert.rejects(executeAtomic(2),/RUN_NOT_FOUND_IN_COMPANY/);await unchanged();ok('APPLICATION RLS rejects foreign company');
 await reset();await admin.query('UPDATE financial_periods SET is_closed=true');await assert.rejects(executeAtomic(),/POSTING_PERIOD_CLOSED/);await unchanged();ok('APPLICATION closed period refused before writer');
 await reset();await admin.query('UPDATE payroll_items SET base_salary=5000001,gross_salary=5200001,net_salary=4900001 WHERE id=11');await assert.rejects(executeAtomic(),/APPROVED_ITEMS_CHANGED/);await unchanged();ok('APPLICATION salary snapshot changed after approval is refused');
 await reset();await admin.query("UPDATE cash_advances SET remaining_amount=499999 WHERE id=801");await assert.rejects(executeAtomic(),/KASBON_RESERVATIONS_INVALID/);assert.equal((await state()).entries,0);assert.equal((await state()).balance,'499999.00');ok('APPLICATION changed kasbon balance is refused');
 for(const table of ['financial_outbox_events','ledger_events','journal_sequences']){
  await reset();await injectedFailure(table,'BEFORE','INSERT',()=>executeAtomic());ok('APPLICATION '+table+' failure rolls back without global escape');
 }
 await reset();await executeAtomic();await admin.query("UPDATE accounting_entries SET status='draft'");await assert.rejects(executeAtomic(),/JOURNAL_NOT_VERIFIED/);assert.equal((await state()).balance,'400000.00');ok('APPLICATION replay rejects non-posted journal');
 await reset();await executeAtomic();await admin.query('UPDATE accounting_entry_lines SET account_id=12 WHERE account_id=11');await assert.rejects(executeAtomic(),/JOURNAL_LINES_CHANGED/);assert.equal((await state()).balance,'400000.00');ok('APPLICATION replay rejects altered account lines even with identical totals');
 await reset();await executeAtomic();await admin.query('DELETE FROM cash_advance_repayments');await assert.rejects(executeAtomic(),/REPAYMENT_LEDGER_COUNT_CHANGED/);assert.equal((await state()).balance,'400000.00');ok('APPLICATION replay rejects missing repayment without silently recreating it');
 await reset();await executeAtomic();await admin.query("UPDATE cash_advance_repayments SET amount=99999");await assert.rejects(executeAtomic(),/REPAYMENT_LEDGER_NOT_VERIFIED/);assert.equal((await state()).repayments,1);ok('APPLICATION replay rejects changed repayment amount');
 await reset();await admin.query("UPDATE cash_advances SET approved_at=NULL,approved_by=NULL");await assert.rejects(executeAtomic(),/KASBON_RESERVATIONS_INVALID/);await unchanged();ok('APPLICATION reads real advance approval metadata rather than fixture constants');
 await reset();await admin.query("UPDATE cash_advances SET employee_id=201");await assert.rejects(executeAtomic(),/RESERVATION_IDENTITY_INVALID/);await unchanged();ok('APPLICATION refuses loan belonging to a different employee');
 await reset();await admin.query("UPDATE payroll_kasbon_auto_reservations SET period='2026-10-01'");await assert.rejects(executeAtomic(),/RESERVATION_IDENTITY_INVALID/);await unchanged();ok('APPLICATION refuses reservation from a different Payroll period');
 await reset();await admin.query("UPDATE accounting_settings SET bpjs_payable_account_id=NULL");await assert.rejects(executeAtomic(),/MAPPING_NOT_UNIQUE_OR_COMPLETE/);await unchanged();await admin.query('UPDATE accounting_settings SET bpjs_payable_account_id=13');ok('APPLICATION loads and validates actual five-account mapping');
 await reset();await admin.query("INSERT INTO payroll_cash_advance_allocations(payroll_item_id,cash_advance_id,amount) VALUES(11,801,100000)");await assert.rejects(executeAtomic(),/LEGACY_ALLOCATIONS_REQUIRE_RECONCILIATION/);await unchanged();await admin.query('TRUNCATE payroll_cash_advance_allocations');ok('APPLICATION blocks overlap with pre-existing legacy allocation ledger');
 await reset();await assert.rejects(executeAtomic(1,{transactionalAccrualVersion:'payroll-accrual-atomic-v1',postAccrualJournal:async()=>({entryId:999999})}),/JOURNAL_NOT_VERIFIED/);await unchanged();ok('APPLICATION rejects a writer claiming a nonexistent journal');
 await reset();await assert.rejects(executeAtomic(1,{transactionalAccrualVersion:'payroll-accrual-atomic-v1',postAccrualJournal:async(mapping:any,params:any,tx:any)=>{const posted=await patched.PayrollJournalService.postAccrualJournal(mapping,params,tx);await tx.execute(sql`UPDATE accounting_entry_lines SET account_id=12 WHERE account_id=11`);return posted;}}),/JOURNAL_LINES_CHANGED/);await unchanged();ok('APPLICATION rejects wrong journal lines before settling kasbon');
 await reset();await admin.query('DELETE FROM financial_periods');await assert.rejects(executeAtomic(),/POSTING_PERIOD_NOT_CONFIGURED/);await unchanged();await admin.query('INSERT INTO financial_periods VALUES(1,2026,11,false,false)');ok('APPLICATION fails closed on missing fiscal period');
 await reset();await admin.query("UPDATE cash_advances SET settled_amount=1000");await assert.rejects(executeAtomic(),/ADVANCE_TOTALS_INCONSISTENT/);await unchanged();ok('APPLICATION refuses inconsistent advance totals');
 await reset();process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED='';await assert.rejects(postReviewedPayrollAccrualTransaction(writer!,patched.PayrollJournalService,{} as any),/DEV_POSTING_DISABLED/);await unchanged();ok('APPLICATION writer stays OFF by default');
 await reset();await admin.query("UPDATE payroll_runs SET approved_at='2026-11-17 10:00:00.123456'::timestamp WHERE id=32");await executeAtomic();
 const precise=(await admin.query("SELECT approved_at::text,posted_at IS NOT NULL AS posted FROM payroll_runs WHERE id=32")).rows[0];
 assert.equal(precise.approved_at,'2026-11-17 10:00:00.123456');assert.equal(precise.posted,true);ok('APPLICATION preserves PostgreSQL microsecond approval time and records posting time');
 await reset();await admin.query("INSERT INTO cash_advance_installment_schedules(advance_id,status) VALUES(801,'pending')");await assert.rejects(executeAtomic(),/LEGACY_INSTALLMENT_SCHEDULE_REQUIRES_RECONCILIATION/);await unchanged();await admin.query('TRUNCATE cash_advance_installment_schedules');ok('APPLICATION blocks loans with pending legacy installment schedules to prevent double settlement');
 await reset();await assert.rejects(executeAtomic(1,original.PayrollJournalService),/TRANSACTIONAL_WRITER_REQUIRED/);await unchanged();ok('APPLICATION refuses the unpatched global-posting native service before opening a connection');
 await reset();const full=fixture();full.items=full.items.map(i=>({...i,kasbonDeduction:'500000.00',totalDeductions:'700000.00',netSalary:'4500000.00'}));full.reservations=full.reservations.map(h=>({...h,amount:'500000.00'}));sign(full);
 await admin.query("UPDATE payroll_items SET kasbon_deduction=500000,total_deductions=700000,net_salary=4500000 WHERE id=11");
 await admin.query("UPDATE payroll_kasbon_auto_reservations SET amount=500000 WHERE id=501");await admin.query("UPDATE payroll_runs SET notes=$1 WHERE id=32",[full.run.notes]);
 await executeAtomic(1,patched.PayrollJournalService,full);const paidLoan=(await admin.query("SELECT remaining_amount::text,status,lifecycle_status,repaid_at IS NOT NULL AS repaid FROM cash_advances WHERE id=801")).rows[0];
 assert.deepEqual(paidLoan,{remaining_amount:'0.00',status:'repaid',lifecycle_status:'settled',repaid:true});assert.equal((await state()).repayments,1);assert.equal((await state()).payments,0);ok('APPLICATION full kasbon settlement reaches zero with one repayment and no salary transfer');
 await reset();const zero=fixture();zero.items=zero.items.map(i=>({...i,kasbonDeduction:'0.00',totalDeductions:'200000.00',netSalary:'5000000.00'}));zero.reservations=[];sign(zero);
 await admin.query("UPDATE payroll_items SET kasbon_deduction=0,total_deductions=200000,net_salary=5000000 WHERE id=11");await admin.query('DELETE FROM payroll_kasbon_auto_reservations');await admin.query('UPDATE payroll_runs SET notes=$1 WHERE id=32',[zero.run.notes]);
 await executeAtomic(1,patched.PayrollJournalService,zero);assert.equal((await state()).repayments,0);assert.equal((await state()).balance,'500000.00');ok('APPLICATION zero-kasbon payroll does not create a repayment or alter an unrelated balance');
 await reset();const many=fixture(),first=many.items[0]!;many.items=Array.from({length:17},(_,n)=>({...first,id:11+n,employeeId:101+n,kasbonDeduction:'0.00',totalDeductions:'200000.00',netSalary:'5000000.00'}));many.activeEmployeeIds=many.items.map(i=>i.employeeId);many.reservations=[];sign(many);
 await admin.query('DELETE FROM payroll_kasbon_auto_reservations;DELETE FROM payroll_items WHERE run_id=32');
 for(const i of many.items){if(i.employeeId!==101)await admin.query("INSERT INTO employees(id,company_id,status) VALUES($1,1,'active')",[i.employeeId]);await admin.query('INSERT INTO payroll_items(id,run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,pph21,other_deductions,kasbon_deduction,total_deductions,net_salary,is_paid) VALUES($1,32,$2,5000000,200000,5200000,100000,50000,50000,0,0,200000,5000000,false)',[i.id,i.employeeId]);}
 await admin.query('UPDATE payroll_runs SET notes=$1 WHERE id=32',[many.run.notes]);const roster=await executeAtomic(1,patched.PayrollJournalService,many);
 const rosterJournal=(await admin.query('SELECT total_debit::text,total_credit::text FROM accounting_entries WHERE id=$1',[roster.entryId])).rows[0];
 assert.deepEqual(rosterJournal,{total_debit:'88400000.00',total_credit:'88400000.00'});assert.equal((await state()).repayments,0);assert.equal((await state()).payments,0);ok('APPLICATION full 17-person roster posts one balanced accrual using database-loaded values');
 // Repayment date belongs to the persisted accrual, even without legacy schedules.
 // Clear only the extra synthetic roster from the preceding 17-person case.
 await reset();await admin.query('DELETE FROM employees WHERE company_id=1 AND id<>101');
 await executeAtomic();await admin.query("UPDATE cash_advance_repayments SET date='2026-11-16'");
 const dateDriftState=await state();await assert.rejects(executeAtomic(),/REPAYMENT_LEDGER_NOT_VERIFIED/);
 assert.deepEqual(await state(),dateDriftState);ok('APPLICATION replay refuses repayment date different from persisted accrual date');
 await reset();await assert.rejects(executeAtomic(1,{transactionalAccrualVersion:'payroll-accrual-atomic-v1',
  postAccrualJournal:async(mapping:any,params:any,tx:any)=>patched.PayrollJournalService.postAccrualJournal(mapping,{...params,date:'2026-11-16'},tx)}),/JOURNAL_DATE_MISMATCH/);
 await unchanged();ok('APPLICATION unexpected first-post journal date rolls back before any kasbon settlement');
 console.log('APPLICATION_REAL_POSTGRES_CHECKS_PASS',passed,'LIVE_CST_DEV_OR_PROD_USED',false,'BANK_TRANSFER_SENT',false);
}finally{if(writer)await writer.end();await admin.end();}
