/** Derive only totals backed by persisted Payroll items, never an empty-array Rp0. */
export type StoredPayrollItem = {
  item: {grossSalary:string;kasbonDeduction:string;netSalary:string};
};
export type StoredPayrollSummary = {
  itemCount:number;gross:number|null;advances:number|null;net:number|null;
};
const numberFromStoredMoney = (v:unknown):number|null => {
  if (typeof v!=="string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v)) return null;
  const n=Number(v);
  // Reject values whose cent precision cannot be represented safely in JS.
  return Number.isFinite(n) && Number.isSafeInteger(Math.round(n * 100)) ? n : null;
};

export function summarizePersistedPayrollItems(items:readonly StoredPayrollItem[]):StoredPayrollSummary {
  const itemCount=items.length;
  const missing={itemCount,gross:null,advances:null,net:null};
  if(itemCount===0)return missing;
  let gross=0,advances=0,net=0;
  for(const {item} of items){
    const a=numberFromStoredMoney(item.grossSalary);
    const b=numberFromStoredMoney(item.kasbonDeduction);
    const c=numberFromStoredMoney(item.netSalary);
    if(a===null||b===null||c===null)return missing;
    gross+=a;advances+=b;net+=c;
  }
  return [gross,advances,net].every(Number.isFinite)
    ? {itemCount,gross,advances,net} : missing;
}
