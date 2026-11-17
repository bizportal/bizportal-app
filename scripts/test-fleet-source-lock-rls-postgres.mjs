#!/usr/bin/env node
// Actual LOGIN proof for lock-only source access, using disposable PostgreSQL only.
// Load fixtures/fleet-source-lock-rls-qa.sql first; never connect shared DEV/PROD.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const deps=process.env.FLEET_QA_DEPENDENCIES||'/opt/bizportal-20261117-audit-main-only';
const socket=process.env.FLEET_QA_PG_SOCKET||'/tmp/fleet-finance-dsv-qa-20261117/pgsocket';
if(!socket.startsWith('/tmp/fleet-finance-dsv-qa-')||!socket.endsWith('/pgsocket'))throw new Error('Only the private disposable QA socket is allowed');
const require=createRequire(path.join(deps,'lib/db/package.json'));
const {Pool}=require('pg');
const base={host:socket,database:'postgres',max:1};
const admin=new Pool({...base,user:'postgres'}),pool=new Pool({...base,user:'bizportal_fleet_finance_login_dev'});
const c=await pool.connect(),owner=await admin.connect(),passed=[];
const table='qa_fleet_lock.fleet_cash_payments';
async function test(name,fn){await fn();passed.push(name);process.stdout.write('PASS '+name+'\n')}
async function deny(query,code){await c.query('BEGIN');try{await assert.rejects(c.query(query),error=>error.code===code)}finally{await c.query('ROLLBACK')}}
try {
 const isolated=(await owner.query('SELECT current_database() database_name,inet_server_addr() server_addr')).rows[0];
 assert.deepEqual(isolated,{database_name:'postgres',server_addr:null});
 const baseline=(await owner.query('SELECT * FROM '+table+' ORDER BY id')).rows;
 await test('actual LOGIN/session identity is non-superuser, NOINHERIT, NOBYPASS and RLS active',async()=>{
  const r=(await c.query("SELECT current_user actor,session_user login,rolsuper,rolinherit,rolbypassrls,row_security_active('qa_fleet_lock.fleet_cash_payments') rls_active FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(r,{actor:'bizportal_fleet_finance_login_dev',login:'bizportal_fleet_finance_login_dev',rolsuper:false,rolinherit:false,rolbypassrls:false,rls_active:true});
 });
 await test('column grant allows UPDATE(id) only, not table UPDATE or amount UPDATE',async()=>{
  const r=(await c.query("SELECT has_column_privilege(current_user,'qa_fleet_lock.fleet_cash_payments','id','UPDATE') id_update,has_column_privilege(current_user,'qa_fleet_lock.fleet_cash_payments','amount','UPDATE') amount_update,has_table_privilege(current_user,'qa_fleet_lock.fleet_cash_payments','UPDATE') table_update")).rows[0];
  assert.deepEqual(r,{id_update:true,amount_update:false,table_update:false});
 });
 await test('source1 SELECT FOR UPDATE acquires a real row lock despite WITH CHECK(false)',async()=>{
  await c.query('BEGIN');
  try {
   assert.deepEqual((await c.query('SELECT id,company_id FROM '+table+' WHERE id=1 FOR UPDATE')).rows,[{id:1,company_id:1}]);
   await owner.query('BEGIN');
   try{await assert.rejects(owner.query('SELECT id FROM '+table+' WHERE id=1 FOR UPDATE NOWAIT'),error=>error.code==='55P03')}finally{await owner.query('ROLLBACK')}
  }finally{await c.query('ROLLBACK')}
 });
 await test('no-op UPDATE id=id is denied by RLS with SQLSTATE42501',async()=>deny('UPDATE '+table+' SET id=id WHERE id=1','42501'));
 await test('amount mutation is denied by column privileges with SQLSTATE42501',async()=>deny('UPDATE '+table+' SET amount=amount+1 WHERE id=1','42501'));
 await test('company3 source stays invisible and un-lockable',async()=>{
  assert.deepEqual((await c.query('SELECT id FROM '+table+' WHERE company_id=3')).rows,[]);
  await c.query('BEGIN');try{assert.deepEqual((await c.query('SELECT id FROM '+table+' WHERE company_id=3 FOR UPDATE')).rows,[])}finally{await c.query('ROLLBACK')}
 });
 await test('spoofed company GUCs cannot widen hardcoded source1 identity boundary',async()=>{
  await c.query('BEGIN');try{
   await c.query("SELECT set_config('app.fleet_source_company_id','3',true),set_config('app.fleet_finance_company_id','1',true)");
   assert.deepEqual((await c.query('SELECT id,company_id FROM '+table+' ORDER BY id')).rows,[{id:1,company_id:1}]);
  }finally{await c.query('ROLLBACK')}
 });
 await test('all row data remains exactly unchanged after transaction rollbacks',async()=>assert.deepEqual((await owner.query('SELECT * FROM '+table+' ORDER BY id')).rows,baseline));
 const result={ok:true,testsPassed:passed.length,role:'bizportal_fleet_finance_login_dev',actualLogin:true,noSetRoleProxy:true,network:'none',publishedPorts:[],forUpdate:true,noOpUpdateSqlState:'42501',amountUpdateSqlState:'42501',otherCompanyHidden:true,rowsUnchanged:true};
 await writeFile(path.join(path.dirname(socket),'lock-result.json'),JSON.stringify(result,null,2));
 process.stdout.write(JSON.stringify(result)+'\n');
}finally{c.release();owner.release();await pool.end();await admin.end()}