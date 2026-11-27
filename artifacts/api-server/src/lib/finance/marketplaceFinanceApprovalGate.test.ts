import {afterEach,describe,expect,it} from "vitest";
import {withMarketplaceFinanceDevTransaction} from "../../../../../lib/db/src/marketplace-finance-dev";

const fields=[
  "APP_ENV","BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV",
  "BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV",
] as const;
const old=Object.fromEntries(fields.map(k=>[k,process.env[k]]));
afterEach(()=>{for(const k of fields){
  if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];
}});
describe("approval-only database transaction independent from unrestricted Finance Writer",()=>{
 it("fails closed when approval flag OFF even if general writer is enabled",async()=>{
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV="true";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
  delete process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV;
  await expect(withMarketplaceFinanceDevTransaction(1,async()=>42,
    {paymentApprovalOnly:true})).rejects.toThrow("DEV_FINANCE_PAYMENT_APPROVAL_DISABLED");
 });
 it("refuses approval-only unless tenant-isolated role mode is enabled",async()=>{
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
  delete process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV;
  await expect(withMarketplaceFinanceDevTransaction(1,async()=>42,
    {paymentApprovalOnly:true})).rejects.toThrow("DEV_FINANCE_PAYMENT_APPROVAL_DISABLED");
 });
 it("refuses approval-only under production environment",async()=>{
  process.env.APP_ENV="production";
  process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
  await expect(withMarketplaceFinanceDevTransaction(1,async()=>42,
    {paymentApprovalOnly:true})).rejects.toThrow("DEV_FINANCE_PAYMENT_APPROVAL_DISABLED");
 });
 it("refuses general writer with only approval flag enabled",async()=>{
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
  delete process.env.BIZPORTAL_MARKETPLACE_CANONICAL_FINANCE_ENABLED_DEV;
  await expect(withMarketplaceFinanceDevTransaction(1,async()=>42))
   .rejects.toThrow("DEV_FINANCE_WRITER_DISABLED");
 });
 it("refuses read-only and approval-only simultaneously",async()=>{
  process.env.APP_ENV="development";
  process.env.BIZPORTAL_MARKETPLACE_PAYMENT_APPROVAL_ENABLED_DEV="true";
  process.env.BIZPORTAL_MARKETPLACE_FINANCE_COMPANY_ROLES_ENABLED_DEV="true";
  await expect(withMarketplaceFinanceDevTransaction(1,async()=>42,
    {paymentApprovalOnly:true,readOnly:true}))
   .rejects.toThrow("DEV_FINANCE_PAYMENT_APPROVAL_DISABLED");
 });
});
