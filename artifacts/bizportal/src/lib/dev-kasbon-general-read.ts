/** CST DEV read-only list routing, independent of client-side role display. */
export function useCstDevKasbonReadPage(hostname:string, companyId:number|null|undefined, consolidated:boolean):boolean {
  return hostname === "dev-bizportal.cstlogistic.co.id" && companyId === 1 && !consolidated;
}
export function canReadCstDevKasbon(role:unknown):boolean {
  return role === "owner" || role === "super_admin";
}
export type DevKasbonRow = {
  id:number; advanceNumber:string|null; date:string|null; employeeName:string|null;
  amountRecorded:string|null; paidRecorded:string|null; remainingRecorded:string|null;
  status:string|null; lifecycleStatus:string|null; postingStatus:string|null;
  approvalRecorded:boolean; disbursementRecorded:boolean; journalReferenceRecorded:boolean;
};
export type DevKasbonPage = {companyId:1;page:number;pageSize:50;total:number;readOnly:true;records:DevKasbonRow[]};
const strings = ["advanceNumber","date","employeeName","amountRecorded","paidRecorded","remainingRecorded","status","lifecycleStatus","postingStatus"] as const;
const booleans = ["approvalRecorded","disbursementRecorded","journalReferenceRecorded"] as const;
function isRow(v:unknown):v is DevKasbonRow {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const row=v as Record<string,unknown>;
  return typeof row.id==="number" && Number.isSafeInteger(row.id) && row.id>0 &&
    strings.every(k=>row[k]===null || typeof row[k]==="string") &&
    booleans.every(k=>typeof row[k]==="boolean");
}
export function parseDevKasbonPage(value:unknown, page:number):DevKasbonPage {
  if (!value || typeof value !== "object") throw Error("Data kasbon tidak tersedia.");
  const v=value as Record<string,unknown>;
  if (v.companyId!==1 || v.page!==page || v.pageSize!==50 || v.readOnly!==true ||
      typeof v.total!=="number" || !Number.isSafeInteger(v.total) || v.total<0 ||
      !Array.isArray(v.records) || v.records.length!==Math.min(50,Math.max(0,v.total-(page-1)*50)) ||
      !v.records.every(isRow) || new Set(v.records.map(r=>r.id)).size!==v.records.length) {
    throw Error("Data kasbon tidak tersedia.");
  }
  return v as DevKasbonPage;
}
export function formatRecordedKasbonAmount(value:string|null):string {
  if(value===null || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) return "Belum tercatat";
  const n=Number(value);
  if(!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER/100) return value+" IDR (tercatat)";
  return new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",minimumFractionDigits:0,maximumFractionDigits:2}).format(n);
}
