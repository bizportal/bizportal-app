import {payrollReadinessSafeReason} from "./payroll-prod-readiness-error";

/** The existing classifier returns fixed tokens only. Keep the DEV response
 * free of raw DB errors, connection strings, role names and addresses. */
export function payrollDevReaderSafeReason(error:unknown):string{
  const e=error&&typeof error==="object"?error as Record<string,unknown>:{};
  const code=typeof e.code==="string"?e.code.toUpperCase():"";
  const message=error instanceof Error?error.message.slice(0,2048).toLowerCase():"";
  // node-postgres pool timeout messages can differ from socket error codes.
  if(code==="ETIMEDOUT"||message.includes("timeout exceeded when trying to connect")||
     message.includes("connection timeout")||message.includes("timeout expired"))
    return "PAYROLL_DEV_DATABASE_NETWORK_OR_TIMEOUT";
  // Supavisor reports this in a FATAL response without a useful SQLSTATE.
  if(message.includes("tenant or user not found")||message.includes("tenant/user not found"))
    return "PAYROLL_DEV_POOLER_ROUTING_FAILED";
  if(message.includes("payroll database credentials changed"))
    return "PAYROLL_DEV_RESTART_REQUIRED";
  return payrollReadinessSafeReason(error).replace(/^PAYROLL_PROD_/,"PAYROLL_DEV_");
}

/** Validate only the public transport classification; never return any URL,
 * username, address, port number, query parameters or password. */
export function payrollDevReaderTransport(raw:string|undefined):
  "direct"|"session_pooler"|"transaction_pooler"|"unrecognized"|"not_configured"{
  if(!raw?.trim())return "not_configured";
  try{
    const u=new URL(raw);
    if(!["postgres:","postgresql:"].includes(u.protocol))return "unrecognized";
    const host=u.hostname.toLowerCase();
    if(host==="db.xssrfshdrtdfupgqwfdw.supabase.co"&&(!u.port||u.port==="5432"))return "direct";
    if(/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)){
      if(!u.port||u.port==="5432")return "session_pooler";
      if(u.port==="6543")return "transaction_pooler";
    }
  }catch{}
  return "unrecognized";
}
