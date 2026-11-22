import { Router, type IRouter } from 'express';
import { authorizePayrollCompany } from './payroll-access';
import { getProductionSession, getProductionUser, isSignedOtpDevEnabled } from './dev-auth';
import { getPayrollPool, payrollDedicatedEnabled } from './payroll-db';
import { registerPayrollFinancialPeriod } from './payroll-financial-period';
const enabled=()=>process.env.APP_ENV==='development' && process.env.PAYROLL_DEV_FINANCIAL_SETUP_ENABLED==='true';
const positive=(value:unknown)=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value)&&Number(value)<=2147483647?Number(value):null;
export function createPayrollFinancialPeriodRouter(): IRouter {
  const router: IRouter=Router();
  if(!enabled())return router;
  router.post('/payroll/runs/:id/register-financial-period',async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(!enabled()){res.status(404).json({code:'NOT_FOUND'});return;}
    try {
      if(!isSignedOtpDevEnabled()){res.status(503).json({code:'SIGNED_SESSION_UNAVAILABLE'});return;}
      const session=getProductionSession(req);
      if(!session){res.status(401).json({code:'AUTH_REQUIRED'});return;}
      const actor=await getProductionUser(session);
      if(!actor || actor.role!=='super_admin'){res.status(403).json({code:'SUPER_ADMIN_REQUIRED'});return;}
      const companyId=positive(req.query.companyId),runId=positive(req.params.id);
      if(!companyId || !runId || Object.keys(req.query).some(key=>key!=='companyId')){res.status(400).json({code:'SCOPE_INVALID'});return;}
      if(authorizePayrollCompany(actor,req.query.companyId)!==companyId){res.status(403).json({code:'COMPANY_DENIED'});return;}
      const allowed=process.env.PAYROLL_DEV_FINANCIAL_SETUP_ALLOWED_ORIGIN?.trim();
      if(!allowed){res.status(503).json({code:'SETUP_ORIGIN_NOT_CONFIGURED'});return;}
      const origin=new URL(allowed);
      if(origin.protocol!=='https:'||origin.origin!==allowed||origin.username||origin.password||origin.pathname!=='/'||origin.hash||origin.search)
        throw Error('SETUP_ORIGIN_INVALID');
      if(req.headers.origin!==allowed||req.headers['sec-fetch-site']==='cross-site'){res.status(403).json({code:'ORIGIN_DENIED'});return;}
      if(!req.is('application/json')){res.status(415).json({code:'JSON_REQUIRED'});return;}
      const body=req.body as Record<string,unknown>|null;
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='requestId'&&k!=='note')||
        typeof body.requestId!=='string'||typeof body.note!=='string'){res.status(400).json({code:'REQUEST_INVALID'});return;}
      if(!payrollDedicatedEnabled()){res.status(503).json({code:'DEDICATED_PAYROLL_CONNECTION_REQUIRED'});return;}
      const result=await registerPayrollFinancialPeriod(getPayrollPool(),{companyId,runId,requestId:body.requestId,note:body.note,
        actor:{id:actor.id,email:actor.email,role:actor.role}});
      res.status(200).json({ok:true,...result});
    } catch(error) {
      const message=error instanceof Error?error.message:'';
      const code=message==='PAYROLL_PERIOD_RUN_NOT_FOUND'?'PAYROLL_NOT_FOUND':
        message==='PAYROLL_PERIOD_REQUEST_INVALID'?'REQUEST_INVALID':
        message==='PAYROLL_PERIOD_VERIFIED_ACTOR_REQUIRED'?'SUPER_ADMIN_REQUIRED':
        /^PAYROLL_PERIOD_(RUN_NOT_ELIGIBLE|RUN_PERIOD_INVALID|PERIOD_NOT_UNIQUE|CLOSED_OR_OVERRIDE_PERIOD|ACCOUNTING_PERIOD_LOCKED|AUDIT_MISSING_OR_CHANGED)$/.test(message)?'PERIOD_SETUP_CONFLICT':'PERIOD_SETUP_UNAVAILABLE';
      const status=code==='PAYROLL_NOT_FOUND'?404:code==='REQUEST_INVALID'?400:code==='SUPER_ADMIN_REQUIRED'?403:code==='PERIOD_SETUP_CONFLICT'?409:503;
      req.log?.warn?.({code},'DEV payroll period setup rejected');res.status(status).json({code});
    }
  });
  return router;
}
