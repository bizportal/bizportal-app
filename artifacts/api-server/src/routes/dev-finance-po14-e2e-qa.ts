/**
 * Signed Super Admin QA run receipt for PO #14; localhost-only isolated PG.
 * This is a SIMULATION of the canonical Finance lifecycle and NOT a
 * substitute for bank importer, true ERP ledger or browser E2E acceptance.
 */
import { Router } from "express";
import pg from "pg";
import {
  getProductionSession,getProductionUser,getFinanceCompanyScope,
  isApprovedFinanceGlobalSuperAdmin,isApprovedFinanceGlobalCompany,
  isDevelopmentEnvironment,
} from "./dev-auth";

const router=Router();
const endpoint="/mkt/admin/po14-e2e-qa";
const expected="postgres://postgres@127.0.0.1:55495/finance_approval_qa";
function gate(){
  return isDevelopmentEnvironment()&&process.env.APP_ENV==="development"&&
    process.env.BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV==="true"&&
    process.env.BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL===expected;
}
async function actor(req:any,res:any):Promise<string|null>{
  if(!gate()){res.status(404).json({error:"Not found"});return null;}
  const session=getProductionSession(req);
  if(!session){res.status(401).json({error:"Sesi Super Admin diperlukan"});return null;}
  try{
    const user=await getProductionUser(session);
    if(!user || user.role.toLowerCase()!=="super_admin"){
      res.status(403).json({error:"Hanya Super Admin"});return null;
    }
    const company=user.companyId===null && isApprovedFinanceGlobalSuperAdmin(user.email)
      ?getFinanceCompanyScope(req,session):user.companyId;
    if(company!==1 || (user.companyId===null && !isApprovedFinanceGlobalCompany(1))){
      res.status(403).json({error:"Pilih dan verifikasi Finance CST"});return null;
    }
    return user.email;
  }catch{
    res.status(503).json({error:"Gagal memverifikasi sesi"});return null;
  }
}
async function withDb<T>(fn:(c:pg.Client)=>Promise<T>):Promise<T>{
  const c=new pg.Client({connectionString:expected,connectionTimeoutMillis:3000});
  await c.connect();
  try{return await fn(c);}finally{await c.end();}
}
function response(run:any, auditCount:number){
  return {
    sandbox:true,bankTransfer:false,businessLedgerPosted:false,
    actualBankReconcilerExecuted:false,actualVendorInvoiceCreated:false,
    result:run?{
      id:run.id,reference:run.reference,companyId:run.company_id,
      actor:run.actor,status:run.status,steps:run.steps,
      amount:run.amount,createdAt:run.created_at,
      auditCount,
    }:null,
  };
}
router.get(endpoint,async(req,res)=>{
  const user=await actor(req,res);if(!user)return;
  try{
    const data=await withDb(async c=>{
      const r=await c.query(
        "select id,reference,company_id,actor,status,steps,amount::text,created_at from public.qa_po14_e2e_runs where company_id=1 and reference='PO-20261117-00014' limit 1"
      );
      const audit=r.rows[0]?await c.query(
        "select count(*)::integer as n from public.qa_po14_e2e_audit where run_id=$1",[r.rows[0].id]
      ):null;
      return response(r.rows[0]??null,audit?.rows[0]?.n??0);
    });
    res.setHeader("Cache-Control","no-store");res.json(data);
  }catch{res.status(503).json({error:"Database E2E QA tidak tersedia"});}
});
router.post(endpoint,async(req,res)=>{
  const user=await actor(req,res);if(!user)return;
  if(!req.is("application/json")||req.header("sec-fetch-site")==="cross-site"){
    res.status(403).json({error:"Hanya JSON dari Finance DEV"});return;
  }
  const origin=req.header("origin");
  if(!origin||origin!=="https://"+req.header("host")){
    res.status(403).json({error:"Origin tidak sesuai"});return;
  }
  if(!req.body||typeof req.body!=="object"||Array.isArray(req.body)||
    Object.keys(req.body).length!==1||req.body.reference!=="PO-20261117-00014"){
    res.status(422).json({error:"Referensi pengujian harus PO #14"});return;
  }
  try{
    const data=await withDb(async c=>{
      await c.query("BEGIN");
      try{
        await c.query("SET LOCAL statement_timeout='8000ms'");
        // Existing row serialized; INSERT conflict controls first-time races.
        await c.query(`insert into public.qa_po14_e2e_runs
          (reference,company_id,actor,status,steps,amount)
          values('PO-20261117-00014',1,$1,'completed',$2::jsonb,100000.00)
          on conflict (reference,company_id) do nothing`,[
          user,JSON.stringify([
            {stage:"PO / GR referensi",status:"SIMULATED",reference:"PO #14 · Shipment #8 · GR #6"},
            {stage:"Vendor Invoice",status:"SIMULATED",reference:"Tidak dibuat pada database bisnis"},
            {stage:"AP / Payment Request",status:"SIMULATED",reference:"Permintaan Rp100.000 QA"},
            {stage:"Persetujuan",status:"SIMULATED",reference:"Sesi Super Admin diverifikasi oleh API"},
            {stage:"Rekonsiliasi bank",status:"SIMULATED",reference:"Tanpa import mutasi bank nyata"},
            {stage:"Posting GL",status:"SIMULATED",reference:"Tanpa jurnal pada CST-DEV"},
            {stage:"Replay & rollback",status:"SIMULATED",reference:"Transaksi QA atomik, tidak ada bisnis write"},
          ])
        ]);
        const q=await c.query(
          "select id,reference,company_id,actor,status,steps,amount::text,created_at from public.qa_po14_e2e_runs where company_id=1 and reference='PO-20261117-00014' for update"
        );
        const row=q.rows[0];
        if(!row||row.actor!==user){
          await c.query("ROLLBACK");return {code:409};
        }
        await c.query(`insert into public.qa_po14_e2e_audit(run_id,actor,action)
          values($1,$2,'sandbox_run_recorded') on conflict(run_id,action) do nothing`,
          [row.id,user]);
        const a=await c.query(
          "select count(*)::integer as n from public.qa_po14_e2e_audit where run_id=$1",[row.id]
        );
        await c.query("COMMIT");
        return {code:200,data:response(row,a.rows[0].n)};
      }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}
    });
    if(data.code!==200){res.status(409).json({error:"Pengujian sudah dimiliki sesi Super Admin lain"});return;}
    res.setHeader("Cache-Control","no-store");res.json(data.data);
  }catch{
    res.status(503).json({error:"Simulasi tidak dapat disimpan; data bisnis tidak berubah"});
  }
});
export default router;
