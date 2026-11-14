import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";
import { isDevelopmentEnvironment } from "./dev-auth";

const router: IRouter = Router();
// Wrap the no-argument overload so TypeScript preserves Promise<PoolClient>.
const connectTemplateVerification = () => pool.connect();
const TYPES = ["invoice","quotation","po","delivery_note","packing_list","manifest","mou","kontrak","nda","sla"] as const;
type DocType = typeof TYPES[number];
const TITLE: Record<DocType,string> = {
  invoice:"INVOICE",quotation:"PENAWARAN / QUOTATION",po:"PURCHASE ORDER",
  delivery_note:"DO / SURAT JALAN",packing_list:"PACKING LIST",
  manifest:"MANIFES PENGIRIMAN",mou:"MEMORANDUM OF UNDERSTANDING",
  kontrak:"KONTRAK",nda:"NON-DISCLOSURE AGREEMENT",sla:"SERVICE LEVEL AGREEMENT",
};
type Company = { id:number; company_name:string|null; name:string|null; company_code:string|null;
  logo_url:string|null; address:string|null; phone:string|null; email:string|null };
const PREFIX="bizportal_dev_document_template_v1:";
const VENUE="GEDUNG SPORT CENTER\nBandar Udara Internasional Soekarno–Hatta, Jl. C3 No.831, RT.001/RW.010, Pajang, Kec. Benda, Kota Tangerang, Banten 15126";
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]??c);
const validType=(x:unknown):x is DocType=>typeof x==="string" && TYPES.includes(x as DocType);
const safeColor=(x:unknown)=>typeof x==="string" && /^#[a-f0-9]{6}$/i.test(x)?x:"#1e3a6e";
const safeLogo=(x:unknown)=>{
  if(typeof x!=="string"||x.length>1024)return "";
  // Keep bundled official logo same-origin; never resolve it to a legacy DEV hostname.
  if(/^\/[A-Za-z0-9/_-]+\.(?:png|jpg|jpeg|webp)$/i.test(x))return x;
  try {const u=new URL(x);
    return u.protocol==="https:"&&!u.username&&!u.password?u.href:"";
  }catch{return "";}
};
function key(companyId:number,t:DocType){return PREFIX+companyId+":"+t;}
function parseConfig(v:string):Record<string,unknown>{try{const x:unknown=JSON.parse(v);return x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};}catch{return {};}}
function validate(value:unknown):Record<string,unknown>|null{
  if(!value||typeof value!=="object"||Array.isArray(value)||JSON.stringify(value).length>16384)return null;
  const data=value as Record<string,unknown>,out:Record<string,unknown>={};
  const strings:Record<string,number>={
    businessLine:120,logoUrl:1024,companyName:200,companyAddress:800,companyPhone:80,
    companyEmail:254,headerText:500,footerText:500,primaryColor:7,accentColor:7,
    defaultTerms:2000,defaultNotes:2000,templateFormat:8,
  };
  for(const [k,max] of Object.entries(strings)){
    if(data[k]!==undefined){if(typeof data[k]!=="string"||(data[k] as string).length>max)return null;out[k]=data[k];}
  }
  for(const k of ["showTax","showSignature","showStamp"]){
    if(data[k]!==undefined){if(typeof data[k]!=="boolean")return null;out[k]=data[k];}
  }
  for(const [k,min,max] of [["fontSize",8,20],["dueDays",0,365]] as const){
    if(data[k]!==undefined){if(!Number.isInteger(data[k])||Number(data[k])<min||Number(data[k])>max)return null;out[k]=data[k];}
  }
  if(data.primaryColor!==undefined&&!/^#[a-f0-9]{6}$/i.test(String(data.primaryColor)))return null;
  if(data.accentColor!==undefined&&!/^#[a-f0-9]{6}$/i.test(String(data.accentColor)))return null;
  if(data.templateFormat!==undefined&&!["html","pdf"].includes(String(data.templateFormat)))return null;
  if(data.customVariables!==undefined){
    if(!Array.isArray(data.customVariables)||data.customVariables.length>30||
      !data.customVariables.every((v:unknown)=>v&&typeof v==="object"&&!Array.isArray(v)&&
      ["name","value","desc"].every((k)=>typeof (v as Record<string,unknown>)[k]==="string"&&
      String((v as Record<string,unknown>)[k]).length<=(k==="value"?500:k==="desc"?250:80))))return null;
    out.customVariables=data.customVariables;
  }
  return out;
}
function resolve(company:Company,type:DocType,data:Record<string,unknown>={}):Record<string,unknown>{
  const cst=company.company_code?.toUpperCase()==="CST";
  const defaults:Record<string,unknown>={
    documentType:type,businessLine:"Logistic/Forwarder",
    logoUrl:company.logo_url||(cst?"/cst-logo.png":""),
    companyName:company.company_name||company.name||"",
    companyAddress:cst?VENUE:company.address||"",
    companyPhone:company.phone||"",companyEmail:company.email||"",
    headerText:"",footerText:"Terima kasih atas kepercayaan Anda.",
    primaryColor:"#1e3a6e",accentColor:"#2563eb",fontSize:11,
    defaultTerms:"",defaultNotes:"",dueDays:14,showTax:true,showSignature:true,
    showStamp:false,templateFormat:"pdf",customVariables:[],
  };
  const merged: Record<string, unknown> = {...defaults,...data,documentType:type};
  if(cst){merged.companyName=defaults.companyName;merged.companyAddress=VENUE;merged.logoUrl=defaults.logoUrl;}
  return merged;
}
function preview(type:DocType,template:Record<string,unknown>):string{
  const ink=safeColor(template.primaryColor),logo=safeLogo(template.logoUrl);
  const freight=["manifest","delivery_note","packing_list"].includes(type);
  const th=freight?["No.","Uraian Barang","Qty","Satuan","Catatan"]:["No.","Deskripsi","Qty","Harga","Subtotal"];
  return [
    "<!doctype html><html lang='id'><head><meta charset='utf-8'><title>",
    esc(TITLE[type])," - Preview</title><style>",
    "@page{size:A4;margin:15mm}body{font:12px/1.6 Arial,sans-serif;max-width:820px;margin:20px auto;color:#1e293b}",
    "header{display:grid;grid-template-columns:132px minmax(0,1fr);align-items:center;gap:24px;max-width:650px;margin:0 auto;padding:6px 0 14px}",
    ".logo{width:132px;height:132px;object-fit:contain}",
    "header .brand{text-align:center;min-width:0}header h2{font-size:19px;letter-spacing:.01em;line-height:1.18;color:",ink,";margin:0;text-transform:uppercase}",
    "header p{white-space:pre-line;overflow-wrap:anywhere;margin:6px 0 0;color:#475569;font-weight:500;font-size:11px;line-height:1.5}",
    ".brand-rule{height:0;border-bottom:3px solid ",ink,";margin-top:3px}",
    ".brand-rule-accent{height:0;border-bottom:1px solid #0284c7;margin-top:3px}",
    "h1{text-align:center;color:",ink,";font-size:26px;font-weight:800;margin:27px 0 8px}",
    ".note{text-align:center;color:#334155;font-size:12px;font-weight:700;margin-bottom:25px}",
    ".grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:15px 0 25px}",
    ".grid section{border-bottom:1px solid #cbd5e1;padding:8px 0}.grid small{display:block;color:#475569;font-weight:700}",
    "table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:9px;text-align:left}",
    "th{background:",ink,";color:#fff}footer{margin-top:30px;color:#334155;font-weight:500}",
    "@media print{body{margin:0}.noprint{display:none}}</style></head><body><header>",
    logo?"<img class='logo' src='"+esc(logo)+"' alt='Logo perusahaan'>":"",
    "<div class='brand'><h2>",esc(template.companyName),"</h2><p>",esc(template.companyAddress),
    "</p><p>",esc(template.companyPhone)," | ",esc(template.companyEmail),"</p></div></header>",
    "<div class='brand-rule'></div><div class='brand-rule-accent'></div>",
    "<h1>",esc(TITLE[type]),"</h1><p class='note'>CONTOH TATA LETAK — BUKAN DOKUMEN TRANSAKSI</p>",
    "<div class='grid'><section><small>No. Dokumen</small>Diisi oleh modul transaksi</section>",
    "<section><small>Tanggal</small>Diisi oleh modul transaksi</section>",
    "<section><small>Penerima</small>Diisi oleh modul transaksi</section>",
    "<section><small>Referensi</small>Diisi oleh modul transaksi</section></div>",
    "<table><thead><tr>",...th.map(x=>"<th>"+esc(x)+"</th>"),"</tr></thead>",
    "<tbody><tr><td colspan='5'>Data asli akan dimasukkan oleh modul transaksi; preview tidak menerbitkan dokumen.</td></tr></tbody></table>",
    "<footer>",esc(template.footerText),"</footer>",
    "<p class='noprint'><button onclick='window.print()'>Cetak / Simpan PDF</button></p></body></html>",
  ].join("");
}
router.use("/settings/documents",async(req:AdminRequest,res,next)=>{
  if(!isDevelopmentEnvironment()){res.status(404).json({error:"Not found"});return;}
  await authenticateAdmin(req,res,next);
});
router.use("/settings/documents",async(req:AdminRequest,res,next)=>{
  const companyId=Number(req.query.companyId??req.adminUser?.companyId);
  if(!Number.isSafeInteger(companyId)||companyId<=0){res.status(400).json({error:"Pilih perusahaan."});return;}
  // An unscoped non-privileged admin must not choose any company by URL.
  const actor=req.adminUser;
  const privileged=["owner","super_admin"].includes(actor?.role?.toLowerCase()??"");
  if(actor?.companyId==null&&!privileged){res.status(403).json({error:"Hak akses perusahaan tidak terverifikasi.",code:"COMPANY_SCOPE_MISSING"});return;}
  if(actor?.companyId!=null&&actor.companyId!==companyId){res.status(403).json({error:"Perusahaan tidak diizinkan.",code:"COMPANY_SCOPE_MISMATCH"});return;}
  try{
    const q=await pool.query<Company>(
      "select id,company_name,name,company_code,logo_url,address,phone,email from public.companies where id=$1 and coalesce(is_active,true)=true limit 1",
      [companyId]);
    if(!q.rows[0]){res.status(404).json({error:"Perusahaan tidak ditemukan."});return;}
    res.locals.documentCompany=q.rows[0];next();
  }catch(error){req.log.error({error},"Document company lookup failed");res.status(503).json({error:"Tidak dapat membaca perusahaan."});}
});
router.get("/settings/documents",async(req,res)=>{
  const c=res.locals.documentCompany as Company;
  try{
    const q=await pool.query<{key:string;value:string;updated_at:string}>(
      "select key,value,updated_at from public.app_config where key like $1 and environment=$2 and is_secret=false",
      [PREFIX+c.id+":%","development"]);
    const map=new Map(q.rows.map(row=>[row.key,row]));
    res.json(TYPES.map(type=>{
      const row=map.get(key(c.id,type)),v=row?.value;
      return {...resolve(c,type,typeof v==="string"?parseConfig(v):{}),updatedAt:row?.updated_at};
    }));
  }catch(error){req.log.error({error},"Document templates list failed");res.status(503).json({error:"Daftar template gagal dimuat."});}
});
/**
 * Authenticated, rollback-only read/write/read verification. The temporary
 * app_config row is never committed. Existing invoices, POs, saved template
 * settings and other company scopes cannot be mutated by this diagnostic.
 */
router.post("/settings/documents/verify",async(req:AdminRequest,res)=>{
  if(req.adminUser?.role?.toLowerCase()!=="super_admin"){
    res.status(403).json({error:"Verifikasi hanya untuk Super Admin."});return;
  }
  const c=res.locals.documentCompany as Company;
  const testKey=PREFIX+c.id+":__verify__:"+randomUUID();
  const sample={documentType:"invoice",headerText:"DEV_VERIFICATION",primaryColor:"#1e3a6e"};
  const stored=JSON.stringify(sample);
  let client: Awaited<ReturnType<typeof connectTemplateVerification>> | undefined;
  let transactionOpen=false;
  try{
    client=await connectTemplateVerification();
    await client.query("BEGIN");
    transactionOpen=true;
    await client.query(
      "insert into public.app_config (key,value,environment,description,is_secret,updated_at) "+
      "values ($1,$2,'development','Transient template verification',false,now())",
      [testKey,stored],
    );
    const read=await client.query<{value:string}>(
      "select value from public.app_config where key=$1 and environment='development' and is_secret=false limit 1",
      [testKey],
    );
    if(read.rows.length!==1||read.rows[0].value!==stored){
      throw new Error("ROUNDTRIP_MISMATCH");
    }
    // Exercise the same pure A4 preview generator without printing or posting.
    const html=preview("invoice",resolve(c,"invoice",sample));
    if(!html.includes("<h1>INVOICE</h1>")||
       !html.includes("text-align:center")||
       !html.includes("@page{size:A4")||
       !html.includes("BUKAN DOKUMEN TRANSAKSI")){
      throw new Error("PREVIEW_CONTRACT_MISMATCH");
    }
    await client.query("ROLLBACK");
    transactionOpen=false;
    res.setHeader("Cache-Control","no-store");
    res.json({
      ok:true,
      environment:"development",
      companyId:c.id,
      actorRole:"super_admin",
      checks:{
        verifiedSession:true,
        companyScope:true,
        writeReadMatch:true,
        rolledBack:true,
        printableA4Html:true,
      },
      documentIssued:false,
      pdfPrintedInBrowser:false,
    });
  }catch(error){
    if(transactionOpen&&client){
      try{await client.query("ROLLBACK");}catch(rollbackError){
        req.log?.error?.({rollbackError},"Document verification rollback failed");
      }
    }
    req.log?.error?.({error},"Document template verification failed");
    res.status(503).json({ok:false,error:"Verifikasi konfigurasi dokumen gagal.",code:"DOCUMENT_VERIFICATION_FAILED"});
  }finally{
    client?.release();
  }
});
router.get("/settings/documents/:type",async(req,res)=>{
  const t=req.params.type;if(!validType(t)){res.status(404).json({error:"Jenis dokumen tidak tersedia."});return;}
  const c=res.locals.documentCompany as Company;
  try{
    const q=await pool.query<{value:string;updated_at:string}>(
      "select value,updated_at from public.app_config where key=$1 and environment=$2 and is_secret=false limit 1",
      [key(c.id,t),"development"]);
    const row=q.rows[0],v=row?.value;
    res.json({...resolve(c,t,typeof v==="string"?parseConfig(v):{}),updatedAt:row?.updated_at});
  }catch(error){req.log.error({error},"Document template read failed");res.status(503).json({error:"Template tidak dapat dimuat."});}
});
router.patch("/settings/documents/:type",async(req,res)=>{
  const t=req.params.type;if(!validType(t)){res.status(404).json({error:"Jenis dokumen tidak tersedia."});return;}
  const data=validate(req.body);if(!data||req.body?.documentType!==t){res.status(400).json({error:"Konfigurasi tidak valid."});return;}
  const c=res.locals.documentCompany as Company;
  try{
    const sql="insert into public.app_config (key,value,environment,description,is_secret,updated_at,updated_by) "+
      "values ($1,$2,'development','BizPortal DEV document template config',false,now(),$3) "+
      "on conflict (key) do update set value=excluded.value,updated_at=now(),updated_by=excluded.updated_by "+
      "returning value,updated_at";
    const q=await pool.query<{value:string;updated_at:string}>(
      sql,[key(c.id,t),JSON.stringify(data),(req as AdminRequest).adminUser?.email||"verified_admin"]);
    res.json({template:{...resolve(c,t,parseConfig(q.rows[0].value)),updatedAt:q.rows[0].updated_at}});
  }catch(error){req.log.error({error},"Document template update failed");res.status(503).json({error:"Template tidak dapat disimpan."});}
});
router.post("/settings/documents/:type/preview",(req,res)=>{
  const t=req.params.type;if(!validType(t)){res.status(404).json({error:"Jenis dokumen tidak tersedia."});return;}
  const data=validate(req.body);if(!data||req.body?.documentType!==t){res.status(400).json({error:"Pratinjau tidak valid."});return;}
  const c=res.locals.documentCompany as Company;
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.setHeader("Cache-Control","no-store");
  res.setHeader("Content-Security-Policy","default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  res.send(preview(t,resolve(c,t,data)));
});
export default router;
