import {describe,it,expect} from "vitest";
import { matchLegacyInstallments, type InstallmentContext, type InstallmentAllocation, type InstallmentSchedule } from "./payroll-legacy-installments";
function fixture(){
 const context:InstallmentContext={companyId:1,runId:32,year:2026,month:11,postingDate:'2026-11-17',approvedAt:'2026-11-17T10:00:00Z',itemIds:[11],replay:false};
 const holds=[{id:'501',advanceId:801,payrollItemId:11,employeeId:101,amount:'100000.00',currentBalance:'200000.00'}];
 const allocations:InstallmentAllocation[]=[{id:1001,itemId:11,advanceId:801,scheduleId:901,amount:'100000.00',beforeApproval:true,referenceCount:1}];
 const schedules:InstallmentSchedule[]=[1,2].map(n=>({id:900+n,companyId:1,advanceId:801,number:n,dueDate:n===1?'2026-11-10':'2026-12-10',amount:'100000.00',status:'pending',repaymentId:null,paidDate:null,paidAmount:null,entryId:null,itemId:null,beforeApproval:true}));
 return {context,holds,allocations,schedules};
}
const apply=(f:ReturnType<typeof fixture>)=>matchLegacyInstallments(f.context,f.holds,f.allocations,f.schedules);
describe('existing installment linkage: strict full-row reconciliation',()=>{
 it('returns one exact link without modifying loan, allocation, schedule or approval',()=>{
  const f=fixture(),before=structuredClone(f);expect(apply(f).get('501')?.id).toBe(901);expect(f).toEqual(before);
 });
 it('leaves ordinary automatic kasbon unchanged without legacy evidence',()=>{
  const f=fixture();f.allocations=[];f.schedules=[];expect(apply(f).size).toBe(0);
 });
 it('accepts oldest overdue installment, not a future one',()=>{
  const f=fixture();f.schedules[0]!.status='overdue';f.schedules[0]!.dueDate='2026-10-10';expect(apply(f).size).toBe(1);
 });
 it.each([
  ['missing schedule',{scheduleId:null}],['wrong loan',{advanceId:802}],['wrong item',{itemId:12}],
  ['amount drift',{amount:'99999.99'}],['late allocation',{beforeApproval:false}],['shared allocation',{referenceCount:2}],
 ])('rejects allocation %s',(_name,mutation)=>{
  const f=fixture();Object.assign(f.allocations[0]!,mutation);expect(()=>apply(f)).toThrow('LINK_NOT_EXACT');
 });
 it.each([
  ['foreign company',{companyId:2}],['foreign loan',{advanceId:802}],['bad amount',{amount:'100001.00'}],
  ['bad date',{dueDate:'2026-02-30'}],['future period',{dueDate:'2026-12-10'}],
 ])('rejects schedule identity %s',(_name,mutation)=>{
  const f=fixture();Object.assign(f.schedules[0]!,mutation);expect(()=>apply(f)).toThrow('LINK_NOT_EXACT');
 });
 it.each([
  ['already paid',{status:'paid'}],['waived',{status:'waived'}],['future day',{dueDate:'2026-11-18'}],
  ['changed after approval',{beforeApproval:false}],['partial amount',{paidAmount:'1.00'}],
  ['has repayment',{repaymentId:1}],['has journal',{entryId:1}],['has payroll item',{itemId:11}],
  ['has paid date',{paidDate:'2026-11-10'}],
 ])('rejects non-clean selected schedule %s',(_name,mutation)=>{
  const f=fixture();Object.assign(f.schedules[0]!,mutation);expect(()=>apply(f)).toThrow('SCHEDULE_NOT_CLEAN_DUE');
 });
 it('rejects incomplete or inflated remaining schedule total',()=>{
  const f=fixture();f.holds[0]!.currentBalance='199999.00';expect(()=>apply(f)).toThrow('SCHEDULE_BALANCE_OR_ORDER_MISMATCH');
 });
 it('cannot skip oldest unpaid installment',()=>{
  const f=fixture();f.context.postingDate='2026-12-17';f.context.month=12;f.allocations[0]!.scheduleId=902;
  expect(()=>apply(f)).toThrow('SCHEDULE_BALANCE_OR_ORDER_MISMATCH');
 });
 it('does not invent an allocation for an existing schedule',()=>{
  const f=fixture();f.allocations=[];expect(()=>apply(f)).toThrow('EXPLICIT_ALLOCATION_REQUIRED');
 });
 it('rejects duplicate allocations or schedule rows',()=>{
  const f=fixture();f.allocations.push({...f.allocations[0]!});expect(()=>apply(f)).toThrow('DUPLICATE_LINK');
  f.allocations.pop();f.schedules.push({...f.schedules[0]!});expect(()=>apply(f)).toThrow('DUPLICATE_LINK');
 });
 it('requires persisted paid schedule evidence on replay, without charging again',()=>{
  const f=fixture();f.context.replay=true;f.holds[0]!.currentBalance='100000.00';
  Object.assign(f.schedules[0]!,{status:'paid',repaymentId:701,entryId:91,itemId:11,paidAmount:'100000.00',paidDate:'2026-11-17',beforeApproval:false});
  expect(apply(f).size).toBe(1);f.schedules[0]!.paidAmount='99999.00';expect(()=>apply(f)).toThrow('PAID_EVIDENCE_INVALID');
 });
 it('detects missing allocation after posting rather than recreating it',()=>{
  const f=fixture();f.context.replay=true;f.allocations=[];Object.assign(f.schedules[0]!,{status:'paid',itemId:11});
  expect(()=>apply(f)).toThrow('PAID_LINK_MISSING');
 });
 it('keeps partial legacy installment settlement unsupported instead of marking paid',()=>{
  const f=fixture();f.allocations[0]!.amount='50000.00';f.holds[0]!.amount='50000.00';
  expect(()=>apply(f)).toThrow('LINK_NOT_EXACT');
 });
});
