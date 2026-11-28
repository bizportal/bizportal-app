import type {IRouter,Request,Response} from "express";
import type {PayrollDbClient} from "@workspace/db";
import {getPayrollPool,payrollDedicatedEnabled,setPayrollCompanyScope} from "./payroll-db";
import {isDevelopmentEnvironment} from "./dev-auth";
import {loadEffectivePayrollSetupPreview} from "./payroll-setup-effective-read";

type ScopedRequest=Request&{payrollCompanyId?:number;payrollActor?:{role:string}};
const allowed=(role?:string)=>["admin","owner","super_admin"].includes(role?.toLowerCase()??"");
function dedicatedReady():boolean{
  try{return isDevelopmentEnvironment()&&payrollDedicatedEnabled();}
  catch{return false;}
}
export function canPreviewEffectiveSetup(role?:string):boolean{
  return allowed(role)&&dedicatedReady();
}

/** Mounted only behind the existing authenticated Payroll company scope.
 * No shared-pool fallback, no PROD, no financial writes or sample roster. */
export function registerEffectiveSetupPreviewRoutes(router:IRouter):void{
  router.get("/payroll/runs/:id/setup-preview",async(req:ScopedRequest,res:Response):Promise<void>=>{
    res.setHeader("Cache-Control","no-store");
    if(!isDevelopmentEnvironment()){
      res.status(404).json({message:"Pratinjau konfigurasi ini hanya tersedia di DEV."});return;
    }
    if(!allowed(req.payrollActor?.role)){
      res.status(403).json({message:"Akses pratinjau gaji ditolak."});return;
    }
    if(!dedicatedReady()){
      res.status(503).json({message:"Pratinjau memerlukan koneksi Payroll DEV khusus."});return;
    }
    const raw=req.params.id,runId=typeof raw==="string"&&/^[1-9][0-9]*$/.test(raw)?Number(raw):NaN;
    const companyId=req.payrollCompanyId;
    if(!Number.isSafeInteger(runId)||runId<1||!Number.isSafeInteger(companyId)||!companyId||companyId<1||
       req.query.sampleEmployeeIds!==undefined){
      res.status(400).json({message:"Periode atau lingkup perusahaan tidak valid."});return;
    }
    let client:PayrollDbClient|undefined,started=false;
    try{
      client=await getPayrollPool().connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");started=true;
      await setPayrollCompanyScope(client,companyId);
      const result=await loadEffectivePayrollSetupPreview((sql,args)=>client!.query(sql,args),companyId,runId);
      await client.query("COMMIT");started=false;
      if(result.kind==="missing"){
        res.status(404).json({message:"Periode bukan milik perusahaan aktif."});return;
      }
      if(result.kind==="not_draft"){
        res.status(409).json({message:"Pratinjau konfigurasi hanya tersedia pada periode Draft."});return;
      }
      res.json(result.preview);
    }catch(error){
      if(started&&client)try{await client.query("ROLLBACK");}catch{}
      req.log?.error?.({error,companyId,runId},"Payroll DEV effective setup preview failed");
      res.status(503).json({message:"Pratinjau tidak dapat dihitung. Tidak ada data yang diubah."});
    }finally{client?.release();}
  });
}
