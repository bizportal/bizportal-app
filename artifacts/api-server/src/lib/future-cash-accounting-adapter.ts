import { prepareApprovedFutureCashJournal, type CashJournal } from "./cash-ledger-posting";
import { prepareFutureCashSource, type FutureCashSource } from "./future-cash-source-identity";
import type { TrustedFutureCashReceipt, TrustedFutureCashApproval, TrustedFutureCashCoa } from "./future-cash-approval-preflight";

/**
 * Staged internal accounting adapter. No runtime pool, route or scheduler
 * instantiates it yet. The caller MUST load trusted evidence inside the
 * same transaction and verify private receipt bytes; no browser claims.
 * Never uses bank_mutations, historical Sheets or the Kas Kecil mapping.
 */
export interface FutureCashAccountingClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql:string, params?:unknown[]
  ):Promise<{rows:T[];rowCount?:number|null}>;
}
export interface FutureCashAccountingEvidence {
  source:FutureCashSource;
  receipt:TrustedFutureCashReceipt|null;
  approval:TrustedFutureCashApproval|null;
  coa:TrustedFutureCashCoa|null;
  approverEmail:string;
}
const decimal=(n:bigint)=> (n/100n).toString()+"."+(n%100n).toString().padStart(2,"0");
const TYPE="sc_future_cash_voucher";

async function assertLines(client:FutureCashAccountingClient,id:string,plan:CashJournal){
  const lines=await client.query<{account_id:number;debit:string;credit:string;company_id:number}>(
    "select account_id,debit::numeric(16,2)::text,credit::numeric(16,2)::text,company_id from public.accounting_entry_lines where entry_id=$1 for update",[id]);
  if(lines.rows.length!==2 || !plan.lines.every(p=>lines.rows.some(l=>l.company_id===1 && l.account_id===p.accountId && l.debit===decimal(p.debitCents) && l.credit===decimal(p.creditCents))))throw Error("SC_CASH_JOURNAL_LINES_MISMATCH");
}
async function assertLedger(client:FutureCashAccountingClient,ref:string,plan:CashJournal){
  const lines=await client.query<{account_id:number;debit:string;credit:string}>(
    "select account_id,debit::numeric(16,2)::text,credit::numeric(16,2)::text from public.fleet_ledger_entries where company_id=1 and source_ref=$1",[ref]);
  if(lines.rows.length!==2 || !plan.lines.every(p=>lines.rows.some(l=>l.account_id===p.accountId && l.debit===decimal(p.debitCents) && l.credit===decimal(p.creditCents))))throw Error("SC_CASH_LEDGER_SYNC_FAILED");
}

/** Must run inside a caller-owned BEGIN/COMMIT with rollback on ANY error.
 * Lock precedes evidence load, ensuring concurrent voucher posting serializes.
 * Loader must also lock the document row, read exact OTP and validate storage.
 */
export async function postApprovedFutureCashWithinTransaction(
  client:FutureCashAccountingClient, transactionId:string,
  loadEvidence:(client:FutureCashAccountingClient,id:string)=>Promise<FutureCashAccountingEvidence>,
):Promise<{id:string;replay:boolean}>{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(transactionId))throw Error("SC_CASH_INVALID_UUID");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1::text,0))",["sc-future-cash:"+transactionId]);
  const e=await loadEvidence(client,transactionId);
  if(e.source.transactionId!==transactionId || !e.approval || !e.approverEmail.trim())throw Error("SC_CASH_EVIDENCE_MISMATCH");
  const plan=prepareApprovedFutureCashJournal(e.source,e.receipt,e.approval,e.coa);
  const identity=prepareFutureCashSource(e.source);
  if(plan.sourceKey!==identity.sourceKey)throw Error("SC_CASH_SOURCE_MISMATCH");
  const ref="SC-CASH-"+transactionId;
  // Require explicit dedicated mapping; never infer from generic cash settings.
  const mappings=await client.query<{id:number}>(
    "select id from public.accounting_journals where company_id=1 and type::text='cash' and is_active and code='CSH-SC-CST' and default_debit_account_id=75839 and default_credit_account_id=75839 for share");
  const journal=mappings.rows[0];
  if(mappings.rows.length!==1 || !journal)throw Error("SC_CASH_DEDICATED_JOURNAL_REQUIRED");
  const existing=await client.query<{id:string;entry_number:string;status:string;checksum_hash:string;ref:string;date:string;journal_id:number;total_debit:string;total_credit:string;ledger_source_type:string;ledger_source_id:string}>(
    "select id::text,entry_number,status::text,checksum_hash,ref,date::text,journal_id,total_debit::numeric(16,2)::text,total_credit::numeric(16,2)::text,ledger_source_type,ledger_source_id from public.accounting_entries where company_id=1 and ((ledger_source_type=$1 and ledger_source_id=$2) or entry_number=$3 or ref=$3) for update",[TYPE,transactionId,ref]);
  if(existing.rows.length>1)throw Error("SC_CASH_DUPLICATE_JOURNAL");
  const old=existing.rows[0];
  if(old){
    if(old.status!=="posted" || old.checksum_hash!==plan.fingerprint || old.ref!==ref || old.entry_number!==ref || old.date!==plan.date || old.journal_id!==journal.id || old.ledger_source_type!==TYPE || old.ledger_source_id!==transactionId || old.total_debit!==decimal(plan.amountCents) || old.total_credit!==decimal(plan.amountCents))throw Error("SC_CASH_REPLAY_MISMATCH");
    await assertLines(client,old.id,plan);
    await assertLedger(client,ref,plan);
    return {id:old.id,replay:true};
  }
  // Existing manual enum is used with explicit immutable voucher provenance,
  // rather than inventing an enum label or borrowing a bank source.
  const created=await client.query<{id:string}>(
    "insert into public.accounting_entries (company_id,entry_number,journal_id,date,ref,description,status,source,total_debit,total_credit,created_by_id,approved_by,approved_at,ledger_source_type,ledger_source_id,checksum_hash,correlation_id,source_schema,source_module,source_table,entry_status) values (1,$1,$2,$3,$1,'Kas Besar SC','draft','manual',$4,$4,$5,$5,$6,$7,$8,$9,$10,'public','cash_bank','sc_future_cash_documents','DRAFT') returning id::text",
    [ref,journal.id,plan.date,decimal(plan.amountCents),e.approverEmail,e.approval.approvedAt,TYPE,transactionId,plan.fingerprint,identity.sourceKey]);
  const id=created.rows[0]?.id;
  if(!id)throw Error("SC_CASH_HEADER_INSERT_FAILED");
  for(const line of plan.lines){
    await client.query("insert into public.accounting_entry_lines (entry_id,account_id,company_id,debit,credit,description,source_module,source_table) values ($1,$2,1,$3,$4,'Kas Besar SC','cash_bank','sc_future_cash_documents')",[id,line.accountId,decimal(line.debitCents),decimal(line.creditCents)]);
  }
  await assertLines(client,id,plan);
  await assertLedger(client,ref,plan);
  const posted=await client.query<{id:string}>("update public.accounting_entries set status='posted',entry_status='POSTED',posted_at=now() where id=$1 and company_id=1 and status='draft' returning id::text",[id]);
  if(posted.rows.length!==1 || posted.rows[0]?.id!==id)throw Error("SC_CASH_POST_FAILED");
  await assertLedger(client,ref,plan);
  return {id,replay:false};
}
