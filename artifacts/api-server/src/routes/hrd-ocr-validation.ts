/**
 * Pure OCR input/review validation functions sourced from existing PROD
 * Travelintrips/CST-BIZPORTAL hrd-document-ocr.ts (2026-11-14).
 * No API routes, environment flags, database, providers, Storage, or network.
 * This deliberately tests existing behavior with synthetic fixtures only;
 * activating OCR and handling private employee documents are NOT in scope.
 */

export const HRD_DOC_TYPES=["ktp","kk","foto","sim","npwp","ijazah","skck","kontrak"] as const;
export type HrdDocumentType=typeof HRD_DOC_TYPES[number];
export const MAX_DOCUMENT_BYTES=5*1024*1024;
const mimeTypes=new Set(["image/jpeg","image/png","image/webp","application/pdf"]);

export const extractionFields=[
 "nik","nama_lengkap","tempat_lahir","tanggal_lahir","alamat","nomor_kk",
 "nomor_dokumen","jenis_sim","masa_berlaku","institusi","jurusan",
 "tahun_lulus","jabatan","tanggal_mulai_kontrak","tanggal_akhir_kontrak",
 "jenis_kelamin","agama","status_perkawinan","rt_rw","kelurahan","kecamatan",
 "anggota_keluarga",
] as const;
export type HrdField=typeof extractionFields[number];
export const allowedDocumentFields:Record<HrdDocumentType,readonly HrdField[]>={
 ktp:["nik","nama_lengkap","tempat_lahir","tanggal_lahir","alamat",
  "jenis_kelamin","agama","status_perkawinan","rt_rw","kelurahan","kecamatan"],
 kk:["nomor_kk","nik","nama_lengkap","alamat","anggota_keluarga"],
 sim:["nomor_dokumen","nama_lengkap","jenis_sim","masa_berlaku"],
 npwp:["nomor_dokumen","nik","nama_lengkap","alamat"],
 ijazah:["nama_lengkap","institusi","jurusan","tahun_lulus","nomor_dokumen"],
 skck:["nama_lengkap","nomor_dokumen","masa_berlaku"],
 kontrak:["nama_lengkap","jabatan","tanggal_mulai_kontrak","tanggal_akhir_kontrak"],
 foto:[]
};
export function fieldsAllowedForDocument(docType:HrdDocumentType,fields:Record<string,string|null>){
 const permitted=allowedDocumentFields[docType];
 if(Object.keys(fields).some(k=>!permitted.includes(k as HrdField)))
  throw Error("FIELD_NOT_ALLOWED_FOR_DOCUMENT");
 return fields;
}

export type HrdExtracted=Record<HrdField,string|null>;
export function validDocType(x:unknown):x is HrdDocumentType{
 return typeof x==="string"&&(HRD_DOC_TYPES as readonly string[]).includes(x);
}
export function validMime(x:unknown):x is string{return typeof x==="string"&&mimeTypes.has(x)}
export function normalizeExtraction(data:unknown,confidence:unknown,warnings:unknown){
 const source=data&&typeof data==="object"&&!Array.isArray(data)?data as Record<string,unknown>:{};
 const out={} as HrdExtracted;
 for(const f of extractionFields){
  const raw=source[f];
  out[f]=typeof raw==="string"?raw.trim().slice(0,f==="anggota_keluarga"?4000:320)||null:null;
 }
 // OCR never invents missing values. NIK must be exactly 16 digits.
 if(out.nik&&!/^\d{16}$/.test(out.nik))out.nik=null;
 if(out.nomor_kk&&!/^\d{16}$/.test(out.nomor_kk))out.nomor_kk=null;
 for(const key of ["tanggal_lahir","masa_berlaku","tanggal_mulai_kontrak","tanggal_akhir_kontrak"] as const){
  if(out[key]&&!/^\d{4}-\d{2}-\d{2}$/.test(out[key]!))out[key]=null;
 }
 const value=typeof confidence==="number"&&Number.isFinite(confidence)?
  Math.max(0,Math.min(1,confidence)):0;
 const flags=Array.isArray(warnings)?warnings.filter(x=>typeof x==="string")
  .slice(0,12).map((x:string)=>x.slice(0,160)):[];
 return {fields:out,confidence:value,warnings:flags};
}
export function validateReviewFields(data:unknown){
 if(!data||typeof data!=="object"||Array.isArray(data))throw Error("INVALID_REVIEW_FIELDS");
 const raw=data as Record<string,unknown>;
 if(Object.keys(raw).some(key=>!(extractionFields as readonly string[]).includes(key)))
  throw Error("UNEXPECTED_REVIEW_FIELD");
 const out:Record<string,string|null>={};
 for(const [key,value] of Object.entries(raw)){
  if(value!==null&&typeof value!=="string")throw Error("INVALID_REVIEW_VALUE");
  const cleaned=typeof value==="string"?value.trim():null;
  if(cleaned && cleaned.length>(key==="anggota_keluarga"?4000:320))throw Error("REVIEW_VALUE_TOO_LONG");
  out[key]=cleaned||null;
 }
 if(out.nik&&!/^\d{16}$/.test(out.nik))throw Error("NIK_MUST_BE_16_DIGITS");
 if(out.nomor_kk&&!/^\d{16}$/.test(out.nomor_kk))throw Error("KK_MUST_BE_16_DIGITS");
 return out;
}

export function ocrProviderFailureCode(status:number,providerCode?:unknown,providerType?:unknown){
 if(!Number.isInteger(status)||status<400||status>599)return "HRD_OCR_PROVIDER_FAILED";
 const allowed=new Set([
  "insufficient_quota","rate_limit_exceeded","billing_hard_limit_reached",
  "credit_balance_exhausted","organization_usage_limit_exceeded",
  "organization_spend_limit_exceeded","project_spend_limit_exceeded",
  "requests","tokens","invalid_api_key","model_not_found","account_deactivated"
 ]);
 // OpenAI's error.code is more specific than error.type. Prefer it, and
 // use the broader type only when the code is missing or not recognized.
 const code=typeof providerCode==="string"?providerCode.trim().toLowerCase():"";
 const type=typeof providerType==="string"?providerType.trim().toLowerCase():"";
 const reason=allowed.has(code)?code:allowed.has(type)?type:"";
 const suffix=reason?"_"+reason.toUpperCase():"";
 return "HRD_OCR_PROVIDER_HTTP_"+status+suffix;
}

export function documentMimeMatches(bytes:Buffer,mime:string){
 if(mime==="application/pdf")return bytes.subarray(0,5).toString("ascii")==="%PDF-";
 if(mime==="image/jpeg")return bytes.length>3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
 if(mime==="image/png")return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==="image/webp")return bytes.subarray(0,4).toString("ascii")==="RIFF"&&
  bytes.subarray(8,12).toString("ascii")==="WEBP";
 return false;
}
