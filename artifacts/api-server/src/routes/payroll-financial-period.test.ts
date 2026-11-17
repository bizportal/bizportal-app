import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import {registerPayrollFinancialPeriod,type PayrollPeriodRegistration} from './payroll-financial-period';
const req:PayrollPeriodRegistration={companyId:1,runId:32,requestId:'d769a067-dd14-4d9e-ae3c-54e7aedf7b68',note:'Synthetic period registration without payroll approval',actor:{id:'synthetic-admin',email:'admin@example.test',role:'super_admin'}};
function fixture(){
 const identity={actor:'bizportal_payroll_dev',login:'bizportal_payroll_dev',rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false};
 const run={id:32,company_id:1,month:11,year:2026,status:'draft',posting_status:'pending',accounting_entry_id:null,payment_entry_id:null};
 const period={id:11,company_id:1,month:11,year:2026,is_closed:false,override_allowed:false,closed_at:null,closed_by:null,period_close_signature:null,close_reason:null};
 const audit={id:'22',company_id:1,run_id:32,action:'period_registered',period_id:11,request_id:req.requestId,actor_id:req.actor.id,actor_email:req.actor.email,note:req.note,bank_account_id:null,source_version:null,evidence_reference:null};
 let inserted=false;const state={missingAudit:false,commitError:null as (Error&{code?:string})|null,rollbackError:false,disableAtInsert:false,failuresRemaining:0};
 const release=vi.fn();
 const query=vi.fn(async(sql:string)=>{
  if(sql==='ROLLBACK'){if(state.rollbackError)throw Error('synthetic rollback failure');inserted=false;return{rows:[]};}
  if(sql==='COMMIT'){if(state.commitError)throw state.commitError;return{rows:[]};}
  if(sql.startsWith('SELECT current_user'))return{rows:[identity]};
  if(sql.includes('FROM public.payroll_runs'))return{rows:[run]};
  if(sql.includes('FROM public.accounting_period_locks'))return{rows:[]};
  if(sql.includes('FROM public.financial_periods'))return{rows:inserted?[period]:[]};
  if(sql.includes('FROM public.payroll_financial_setup_events'))return{rows:inserted&&!state.missingAudit?[audit]:[]};
  if(sql.startsWith('INSERT INTO public.financial_periods')){
   if(state.failuresRemaining-->0)throw Object.assign(Error('synthetic retryable conflict'),{code:'40001'});
   inserted=true;if(state.disableAtInsert)process.env.PAYROLL_DEV_FINANCIAL_SETUP_ENABLED='false';return{rows:[period],rowCount:1};
  }
  if(sql.startsWith('BEGIN')||sql.startsWith('SET LOCAL')||sql.startsWith('SELECT set_config')||sql.startsWith('SELECT pg_advisory'))return{rows:[]};
  throw Error('UNEXPECTED_TEST_QUERY');
 });
 const connect=vi.fn(async()=>({query,release}));
 return{identity,run,period,audit,state,query,release,connect,pool:{connect} as unknown as Pick<Pool,'connect'>};
}
beforeEach(()=>{vi.stubEnv('APP_ENV','development');vi.stubEnv('PAYROLL_DEV_FINANCIAL_SETUP_ENABLED','true');vi.stubEnv('BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV',req.actor.id);vi.stubEnv('BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV',req.actor.email);});
afterEach(()=>vi.unstubAllEnvs());
describe('audited Payroll period registration transaction contract',()=>{
 it('commits only the three-column period insert after matching trigger-generated audit',async()=>{const f=fixture();const r=await registerPayrollFinancialPeriod(f.pool,req);
  expect(r).toEqual({periodId:11,auditEventId:'22',created:true,replayed:false,companyId:1,runId:32,payrollApproved:false,fundingApproved:false,accountingPosted:false,salaryPaid:false});
  const writes=f.query.mock.calls.map(([sql])=>sql).filter(sql=>/^(INSERT|UPDATE|DELETE|ALTER|GRANT|REVOKE)/.test(sql));
  expect(writes).toHaveLength(1);expect(writes[0]).toContain('financial_periods(company_id,month,year)');expect(writes[0]).not.toContain('override_allowed)');
  expect(f.query.mock.calls.at(-1)![0]).toBe('COMMIT');expect(f.release).toHaveBeenCalledWith(undefined);
 });
 it.each(['production',''])('does not connect outside DEV (%s)',async value=>{const f=fixture();vi.stubEnv('APP_ENV',value);await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('DEV_DISABLED');expect(f.connect).not.toHaveBeenCalled();});
 it('does not connect when disabled or actor pin is missing',async()=>{const f=fixture();vi.stubEnv('PAYROLL_DEV_FINANCIAL_SETUP_ENABLED','');await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('DEV_DISABLED');
  vi.stubEnv('PAYROLL_DEV_FINANCIAL_SETUP_ENABLED','true');vi.stubEnv('BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV','');await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('VERIFIED_ACTOR_REQUIRED');expect(f.connect).not.toHaveBeenCalled();});
 it.each([{companyId:0},{runId:2147483648},{requestId:'not-a-uuid'},{note:'short'},{note:'a'.repeat(501)}])('rejects malformed request %j',async mutation=>{const f=fixture();await expect(registerPayrollFinancialPeriod(f.pool,{...req,...mutation})).rejects.toThrow('REQUEST_INVALID');expect(f.connect).not.toHaveBeenCalled();});
 it.each([{id:'different'}, {email:'other@example.test'},{role:'owner'}])('rejects actor mismatch %j',async mutation=>{const f=fixture();await expect(registerPayrollFinancialPeriod(f.pool,{...req,actor:{...req.actor,...mutation}})).rejects.toThrow('VERIFIED_ACTOR_REQUIRED');expect(f.connect).not.toHaveBeenCalled();});
 it.each(['actor','login'] as const)('rejects role switching in %s',async field=>{const f=fixture();f.identity[field]='postgres';await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('DEDICATED_IDENTITY_REQUIRED');expect(f.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');});
 it.each(['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb'] as const)('rejects elevated %s',async field=>{const f=fixture();f.identity[field]=true;await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('DEDICATED_IDENTITY_REQUIRED');});
 it('rolls back missing trigger audit instead of accepting the new period',async()=>{const f=fixture();f.state.missingAudit=true;await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('AUDIT_MISSING_OR_CHANGED');expect(f.query.mock.calls.some(([s])=>s==='COMMIT')).toBe(false);});
 it('rolls back an altered audit',async()=>{const f=fixture();f.audit.note='changed';await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('AUDIT_MISSING_OR_CHANGED');expect(f.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');});
 it('retries a proven serialization abort only after rollback',async()=>{const f=fixture();f.state.failuresRemaining=1;expect((await registerPayrollFinancialPeriod(f.pool,req)).created).toBe(true);expect(f.connect).toHaveBeenCalledTimes(2);expect(f.query.mock.calls.filter(([q])=>q==='ROLLBACK')).toHaveLength(1);});
 it('bounds serialization retries and does not commit exhaustion',async()=>{const f=fixture();f.state.failuresRemaining=5;await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('REGISTRATION_FAILED');expect(f.connect).toHaveBeenCalledTimes(3);expect(f.query.mock.calls.filter(([q])=>q==='ROLLBACK')).toHaveLength(3);});
 it('does not auto-retry an ambiguous network COMMIT result',async()=>{const f=fixture();f.state.commitError=Error('synthetic unknown COMMIT outcome');await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('REGISTRATION_FAILED');expect(f.connect).toHaveBeenCalledTimes(1);});
 it('rolls back when the DEV gate is disabled before commit',async()=>{const f=fixture();f.state.disableAtInsert=true;await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('DEV_DISABLED');expect(f.query.mock.calls.some(([s])=>s==='COMMIT')).toBe(false);});
 it('discards the connection when rollback fails',async()=>{const f=fixture();f.identity.actor='postgres';f.state.rollbackError=true;await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow('DEDICATED_IDENTITY_REQUIRED');expect(f.release).toHaveBeenCalledWith(expect.objectContaining({message:'PAYROLL_PERIOD_ROLLBACK_FAILED'}));});
 it('redacts connection exceptions without leaking a DSN',async()=>{const f=fixture();f.connect.mockRejectedValueOnce(Error('postgresql://name:secret@private.invalid'));await expect(registerPayrollFinancialPeriod(f.pool,req)).rejects.toThrow(/^PAYROLL_PERIOD_CONNECTION_UNAVAILABLE$/);expect(f.release).not.toHaveBeenCalled();});
});
