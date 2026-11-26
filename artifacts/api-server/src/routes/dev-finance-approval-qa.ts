import { Router } from "express";
import pg from "pg";
import {
  getProductionSession,getProductionUser,getFinanceCompanyScope,
  isApprovedFinanceGlobalSuperAdmin,isApprovedFinanceGlobalCompany,
  isDevelopmentEnvironment,
} from "./dev-auth";

const router=Router();
const DEV_FLAG="BIZPORTAL_FINANCE_APPROVAL_QA_ENABLED_DEV";
const dbUrl=()=>process.env.BIZPORTAL_FINANCE_APPROVAL_QA_DATABASE_URL;
function eligibleUrl(value:string|undefined){
 if(!value)return false;
 try{
  const u=new URL(value);
  return u.protocol==="postgres:" &&
    u.hostname==="127.0.0.1" &&
    u.port==="55495" &&
    u.pathname==="/finance_approval_qa";
 }catch{return false;}
}
async function actor(req:any,res:any){
 if(!isDevelopmentEnvironment() || process.env.APP_ENV!=="development" ||
   process.env[DEV_FLAG]!=="true" || !eligibleUrl(dbUrl())){
   res.status(404).json({error:"Not found"});return null;
 }
 const session=getProductionSession(req);
 if(!session){res.status(401).json({error:"Sesi Super Admin diperlukan"});return null;}
 try{
  const user=await getProductionUser(session);
  if(!user || user.role.toLowerCase()!=="super_admin"){
   res.status(403).json({error:"Hanya Super Admin"});return null;
  }
  let company=user.companyId;
  if(company===null && isApprovedFinanceGlobalSuperAdmin(user.email)){
   const scoped=getFinanceCompanyScope(req,session);
   if(scoped!==null && isApprovedFinanceGlobalCompany(scoped))company=scoped;
  }
  if(company!==1 && company!==3){
   res.status(403).json({error:"Pilih dan verifikasi perusahaan Finance"});return null;
  }
  return {email:user.email,companyId:company};
 }catch{
  res.status(503).json({error:"Sesi belum dapat diverifikasi"});return null;
 }
}
async function withQa<T>(fn:(client:pg.Client)=>Promise<T>){
 const client=new pg.Client({connectionString:dbUrl(),connectionTimeoutMillis:3000});
 await client.connect();
 try{return await fn(client);}
 finally{await client.end();}
}
function sameOrigin(req:any){
 const origin=req.header("origin");
 if(!origin || req.header("sec-fetch-site")==="cross-site")return false;
 try{
  const u=new URL(origin);
  return u.protocol==="https:" && u.host===req.header("host") && u.origin===origin;
 }catch{return false;}
}
router.get("/mkt/admin/payment-approval-qa",async(req,res)=>{
 const user=await actor(req,res);if(!user)return;
 try{
  const rows=await withQa(c=>c.query(
   "select id,company_id,scenario_ref,amount::text,status,approved_at from public.qa_approval_scenarios where company_id=$1 order by id limit 1",
   [user.companyId]
  ));
  const scenario=rows.rows[0];
  if(!scenario){res.status(404).json({error:"Skenario QA tidak tersedia"});return;}
  res.json({scenario:{id:scenario.id,companyId:scenario.company_id,
   reference:scenario.scenario_ref,amount:scenario.amount,status:scenario.status,
   approvedAt:scenario.approved_at},sandbox:true,bankTransfer:false,glPosted:false});
 }catch{
  res.status(503).json({error:"Database simulasi QA tidak tersedia"});
 }
});
router.post("/mkt/admin/payment-approval-qa",async(req,res)=>{
 const user=await actor(req,res);if(!user)return;
 if(!sameOrigin(req)||!req.is("application/json")){
  res.status(403).json({error:"Permintaan harus berasal dari halaman Finance yang sama"});return;
 }
 const body=req.body;
 if(!body || typeof body!=="object" || Array.isArray(body) ||
   Object.keys(body).length!==1 || !Number.isSafeInteger(body.scenarioId)){
  res.status(422).json({error:"ID transaksi uji tidak valid"});return;
 }
 try{
  const result=await withQa(async c=>{
   await c.query("BEGIN");
   try{
    await c.query("SET LOCAL statement_timeout='8000ms'");
    const q=await c.query(
      "select id,company_id,scenario_ref,amount::text,status,approved_by from public.qa_approval_scenarios where id=$1 and company_id=$2 for update",
      [body.scenarioId,user.companyId]
    );
    if(q.rows.length!==1){await c.query("ROLLBACK");return {code:404,error:"Transaksi QA tidak ditemukan"};}
    const row=q.rows[0];
    if(row.status==="approved"){
     if(row.approved_by!==user.email){await c.query("ROLLBACK");return {code:409,error:"Transaksi telah disetujui sesi berbeda"};}
     await c.query("COMMIT");return {code:200,status:"approved",replay:true,reference:row.scenario_ref};
    }
    if(row.status!=="pending"){await c.query("ROLLBACK");return {code:409,error:"Status QA tidak dapat disetujui"};}
    await c.query("update public.qa_approval_scenarios set status='approved',approved_by=$2,approved_at=now() where id=$1 and company_id=$3 and status='pending'",
      [row.id,user.email,user.companyId]);
    await c.query("insert into public.qa_approval_audit(scenario_id,company_id,actor,action) values($1,$2,$3,'signed_superadmin_approved')",
      [row.id,user.companyId,user.email]);
    await c.query("COMMIT");
    return {code:200,status:"approved",replay:false,reference:row.scenario_ref};
   }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}
  });
  if(result.code!==200){res.status(result.code).json({error:result.error});return;}
  res.json({ok:true,status:result.status,replay:result.replay,reference:result.reference,
   sandbox:true,bankTransfer:false,glPosted:false,
   message:"Persetujuan Super Admin tercatat pada PostgreSQL QA terisolasi; tidak ada pembayaran atau jurnal perusahaan."});
 }catch{res.status(503).json({error:"Persetujuan QA tidak dapat disimpan; belum ada perubahan bisnis"});}
});
export default router;
