import type {IRouter,Request,Response} from "express";
import type {PayrollDbClient} from "@workspace/db";
import {getPayrollPool,payrollDedicatedEnabled,setPayrollCompanyScope} from "./payroll-db";
import {isDevelopmentEnvironment} from "./dev-auth";
import {loadEffectivePayrollSetupPreview} from "./payroll-setup-effective-read";

type ScopedRequest=Request&{payrollCompanyId?:number;payrollActor?:{role:string}};
const allowed=(role?:string)=>["admin","owner","super_admin"].includes(role?.toLowerCase()??"");
export type PayrollPreviewAvailability =
  "ready" | "dev_only" | "role_not_allowed" |
  "dedicated_reader_not_configured" | "dedicated_reader_config_invalid";

/**
 * Public status code only. Never include the database URL, username,
 * connection error text, or other secret-bearing configuration in API output.
 */
export function payrollPreviewAvailability(role?:string):PayrollPreviewAvailability{
  if(!isDevelopmentEnvironment())return "dev_only";
  if(!allowed(role))return "role_not_allowed";
  try{
    return payrollDedicatedEnabled()?"ready":"dedicated_reader_not_configured";
  }catch{
    return "dedicated_reader_config_invalid";
  }
}
function dedicatedReady():boolean{
  return payrollPreviewAvailability("super_admin")==="ready";
}
export function canPreviewEffectiveSetup(role?:string):boolean{
  return payrollPreviewAvailability(role)==="ready";
}

export type PayrollReaderConnectionFailure =
  "authentication_failed" | "hostname_unresolved" | "network_unreachable" |
  "connection_refused" | "connection_timeout" | "tls_failure" | "unknown";

/** Whitelisted error categories only; never serialize an Error object or message. */
export function classifyPayrollReaderConnectionError(error:unknown):PayrollReaderConnectionFailure{
  const codeOf=(value:unknown):string|undefined=>{
    if(!value||typeof value!=="object"||!("code" in value))return undefined;
    return typeof value.code==="string"?value.code:undefined;
  };
  const code=codeOf(error)??(
    error&&typeof error==="object"&&"cause" in error?codeOf(error.cause):undefined
  );
  switch(code){
    case "28P01": case "28000": return "authentication_failed";
    case "ENOTFOUND": case "EAI_AGAIN": return "hostname_unresolved";
    case "ENETUNREACH": case "EHOSTUNREACH": return "network_unreachable";
    case "ECONNREFUSED": return "connection_refused";
    case "ETIMEDOUT": case "ETIMEOUT": case "ECONNRESET": return "connection_timeout";
    case "CERT_HAS_EXPIRED": case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT": case "ERR_TLS_CERT_ALTNAME_INVALID": return "tls_failure";
    default:return "unknown";
  }
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
    let stage:"reader_connect"|"begin_read_only"|"company_scope"|"read_preview"|"commit"="reader_connect";
    try{
      client=await getPayrollPool().connect();
      stage="begin_read_only";
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");started=true;
      stage="company_scope";
      await setPayrollCompanyScope(client,companyId);
      stage="read_preview";
      const result=await loadEffectivePayrollSetupPreview((sql,args)=>client!.query(sql,args),companyId,runId);
      stage="commit";
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
      req.log?.error?.({error,companyId,runId,stage},"Payroll DEV effective setup preview failed");
      // Fixed failure stages contain no SQL, credentials, employee information or exception text.
      res.status(503).json({message:"Pratinjau tidak dapat dihitung. Tidak ada data yang diubah.",previewFailureStage:stage,...(stage==="reader_connect"?{readerConnectionFailure:classifyPayrollReaderConnectionError(error)}:{})});
    }finally{client?.release();}
  });
}
