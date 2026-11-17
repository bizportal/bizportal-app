#!/usr/bin/env node
// Actual Fleet client -> actual canonical Express router -> isolated PostgreSQL.
// Requires captured schema + exact reviewed scoped-runtime-role SQL in disposable postgres.
// The actual DEV transaction wrapper runs; only pg transport uses a private Unix socket.
// TLS configuration is checked here; real TLS negotiation is a separate DEV gate.
// Never accepts a TCP database host or a shared database name.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deps = process.env.FLEET_QA_DEPENDENCIES || "/opt/bizportal-20261117-audit-main-only";
const fleetRepo = process.env.FLEET_QA_CLIENT_REPO || "/opt/fleet-finance-dsv-dev-20261117";
const socket = process.env.FLEET_QA_PG_SOCKET || "/tmp/fleet-finance-dsv-qa-20261117/pgsocket";
if (!socket.startsWith("/tmp/fleet-finance-dsv-qa-") || !socket.endsWith("/pgsocket")) throw new Error("Only the private disposable QA socket is allowed");
const req = createRequire(path.join(deps, "package.json"));
function dependency(name) {
  for (const manifest of ["package.json", "artifacts/api-server/package.json", "lib/db/package.json"]) {
    try { return createRequire(path.join(deps, manifest))(name); } catch {}
  }
  throw new Error("Missing QA dependency: " + name);
}
const { Pool } = dependency("pg");
const { build } = dependency("esbuild");
const express = dependency("express");
const admin = new Pool({host:socket,database:"postgres",user:"postgres",max:2});
const apiPool = new Pool({host:socket,database:"postgres",user:"bizportal_fleet_finance_login_dev",max:2});
const ledgerSyncWarnings = [];
apiPool.on("connect",client=>client.on("notice",notice=>{
  if(notice.message?.includes("[fn_sync_entry_line_to_ledger] INSERT gagal"))ledgerSyncWarnings.push(notice.message);
}));
let server, scratch;
const passed = [];
const proof = {};
async function test(name, fn) {
  await fn(); passed.push(name); process.stdout.write("PASS " + name + "\n");
}
async function scalar(sql, values=[]) { return (await admin.query(sql, values)).rows[0]; }
async function rejects(promise, pattern) { await assert.rejects(promise, pattern); }
async function financialSnapshot() {
  return scalar("SELECT (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM public.fleet_cash_payments p) source,(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM public.accounting_entries e) entries,(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]'::jsonb) FROM public.accounting_entry_lines l) lines,(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]'::jsonb) FROM public.fleet_ledger_entries l) ledger");
}
async function deniedLedgerInsert(action) {
  const before=await financialSnapshot(),warningCount=ledgerSyncWarnings.length;
  await admin.query("REVOKE INSERT ON public.fleet_ledger_entries FROM bizportal_fleet_finance_login_dev");
  try {
    const grants=(await apiPool.query("SELECT has_table_privilege(current_user,'public.fleet_ledger_entries','SELECT') can_read,has_table_privilege(current_user,'public.fleet_ledger_entries','INSERT') can_insert,has_column_privilege(current_user,'public.fleet_cash_payments','id','UPDATE') can_lock_source")).rows[0];
    assert.deepEqual(grants,{can_read:true,can_insert:false,can_lock_source:true});
    const response=await action();
    assert.equal(response.status,409);assert.match(String(response.body.error),/derived ledger/i);
    const warnings=ledgerSyncWarnings.slice(warningCount);
    assert.equal(warnings.length,2,"The real trigger must attempt and swallow both denied ledger INSERTs");
    assert.ok(warnings.every(message=>message.includes("permission denied for table fleet_ledger_entries")));
    assert.deepEqual(await financialSnapshot(),before,"Rejected posting must roll back every candidate header/line and retain original source/journals/ledger");
    return {status:409,triggerWarnings:2,rolledBack:true,sourceAndOriginalUnchanged:true};
  } finally {
    await admin.query("GRANT INSERT ON public.fleet_ledger_entries TO bizportal_fleet_finance_login_dev");
  }
}
async function hiddenLedgerReplay(sourceType,sourceId,action) {
  assert.ok(["fleet_cash_payment","reversal"].includes(sourceType));assert.ok(Number.isSafeInteger(sourceId)&&sourceId>0);
  const before=await financialSnapshot();
  await admin.query("CREATE POLICY qa_ledger_visibility_failure ON public.fleet_ledger_entries AS RESTRICTIVE FOR SELECT TO bizportal_fleet_finance_login_dev USING (NOT(source_type='"+sourceType+"' AND source_id="+sourceId+"))");
  try {
    assert.equal((await apiPool.query("SELECT count(*)::int n FROM public.fleet_ledger_entries WHERE source_type=$1 AND source_id=$2",[sourceType,sourceId])).rows[0].n,0);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.fleet_ledger_entries WHERE source_type=$1 AND source_id=$2",[sourceType,sourceId])).n,2);
    const response=await action();assert.equal(response.status,409);assert.match(String(response.body.error),/derived ledger/i);
    assert.deepEqual(await financialSnapshot(),before);
    return {status:409,visibleLedgerRows:0,physicalLedgerRows:2,financialRowsUnchanged:true};
  } finally {
    await admin.query("DROP POLICY qa_ledger_visibility_failure ON public.fleet_ledger_entries");
  }
}
try {
  const isolation = await scalar("SELECT current_database() db, inet_server_addr() addr, version() version");
  assert.equal(isolation.db,"postgres"); assert.equal(isolation.addr,null);
  proof.database = {name:isolation.db,network:"none",unixSocket:true,postgres:isolation.version.split(" ").slice(0,2).join(" ")};
  // Runtime roles and policies must come from the exact reviewed DEV migration;
  // this harness does not widen their grants.
  await admin.query("BEGIN");
  await admin.query("INSERT INTO public.companies(id,name,company_name,code,company_code,is_active) VALUES (1,'QA Fleet Source','QA Fleet Source','QA-CST','QA-CST',true),(2,'QA Other','QA Other','QA-OTHER','QA-OTHER',true),(3,'PT Diva Servis','PT Diva Servis','DVS','DVS',true) ON CONFLICT(id) DO NOTHING");
  const accounts = [
    [49187,3,"1-1010-DV","QA Kas Diva","asset",true,true,false],
    [49191,3,"1-1030-DV","QA Piutang Diva","asset",true,true,false],
    [49192,3,"1-1031-DV","QA Alternative Diva","asset",true,true,false],
    [49097,1,"1-1010-CST","QA Kas Source","asset",true,true,false],
    [49101,1,"1-1030-CST","QA Piutang Source","asset",true,true,false],
    [900001,3,"QA-HEADER","QA Header","asset",true,false,true],
    [900002,3,"QA-NONPOSTABLE","QA Nonpostable","asset",true,false,false],
    [900003,3,"QA-INACTIVE","QA Inactive","asset",false,true,false],
    [900004,3,"QA-EXPENSE","QA Expense","expense",true,true,false],
  ];
  for (const row of accounts) await admin.query("INSERT INTO public.chart_of_accounts(id,company_id,code,name,type,is_active,is_postable,is_header,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE')",row);
  await admin.query("INSERT INTO public.accounting_journals(id,company_id,code,name,type,is_active) VALUES (20,3,'CSH-DV','QA Cash Diva','cash',true),(6,1,'CSH-CST','QA Cash Source','cash',true),(21,3,'INACTIVE-DV','QA Inactive Journal','cash',false)");
  await admin.query("INSERT INTO public.accounting_settings(id,company_id,default_cash_account_id,ar_account_id,cash_journal_id,fleet_cash_account_id,fleet_driver_receivable_account_id) VALUES(1,1,49097,49101,6,49097,49101),(3,3,49187,49191,20,NULL,NULL)");
  const primary = {companyId:1,paymentId:990117301,amount:12500.25,driverName:"QA Fleet DSV Primary",paymentDate:"2026-11-17",referenceNo:"QA-FLEET-DSV-301",actor:"fleet-finance-qa"};
  const parallel = {...primary,paymentId:990117302,amount:7000,driverName:"QA Fleet DSV Parallel",referenceNo:"QA-FLEET-DSV-302"};
  const blocked = {...primary,paymentId:990117303,amount:9000,driverName:"QA Fleet DSV Negative",referenceNo:"QA-FLEET-DSV-303"};
  const closed = {...primary,paymentId:990117309,amount:1000,driverName:"QA Fleet Closed Period",paymentDate:"2026-10-01",referenceNo:"QA-FLEET-DSV-309"};
  for (const p of [primary,parallel,blocked,closed]) await admin.query("INSERT INTO public.fleet_cash_payments(id,company_id,driver_name,payment_date,amount,payment_method,reference_no,recorded_by,status) VALUES($1,$2,$3,$4::date,$5,'cash',$6,$7,'confirmed')",[p.paymentId,p.companyId,p.driverName,p.paymentDate,p.amount,p.referenceNo,p.actor]);
  await admin.query("INSERT INTO public.financial_periods(id,company_id,month,year,is_closed,override_allowed) VALUES(990117309,3,10,2026,true,false)");
  await admin.query("COMMIT");
  const baseline = await scalar("SELECT count(*)::int source_rows, md5(string_agg(to_jsonb(p)::text,',' ORDER BY id)) source_hash FROM public.fleet_cash_payments p");
  scratch = await mkdtemp(path.join(tmpdir(),"fleet-finance-dsv-qa-bundle-"));
  // Only transport is redirected. The real wrapper validates its URL/TLS options,
  // actual login/session identity, RLS, scope and transactional GUCs against PG.
  globalThis.__fleetFinanceQaConnect = options => {
    assert.equal(options.host,"db.xssrfshdrtdfupgqwfdw.supabase.co");
    assert.equal(options.user,"bizportal_fleet_finance_login_dev");
    assert.equal(options.database,"postgres");assert.equal(options.max,2);
    assert.equal(options.ssl.rejectUnauthorized,true);assert.ok(options.ssl.ca);
    proof.actualTransactionWrapper=true;
    return apiPool;
  };
  const alias = {name:"isolated-transport",setup(b){
    b.onResolve({filter:/^@workspace\/db\/fleet-finance-dev$/},()=>({path:path.join(repo,"lib/db/src/fleet-finance-dev.ts")}));
    b.onResolve({filter:/^pg$/},()=>({path:"qa-pg",namespace:"qa"}));
    b.onLoad({filter:/.*/,namespace:"qa"},()=>({contents:"export default {Pool: class {constructor(options){return globalThis.__fleetFinanceQaConnect(options)}}};",loader:"js"}));
  }};
  await build({entryPoints:[path.join(repo,"artifacts/api-server/src/routes/fleet-finance-integration.ts")],outfile:path.join(scratch,"receiver.cjs"),platform:"node",target:"node22",format:"cjs",bundle:true,plugins:[alias],nodePaths:[path.join(deps,"node_modules"),path.join(deps,"artifacts/api-server/node_modules")],logLevel:"silent"});
  const token = randomBytes(24).toString("hex");
  process.env.APP_ENV="development";
  process.env.FLEET_FINANCE_DATABASE_ENABLED_DEV="true";
  process.env.FLEET_FINANCE_DATABASE_URL_DEV="postgresql://bizportal_fleet_finance_login_dev:qa_transport_only@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=verify-full";
  delete process.env.FLEET_FINANCE_GCP_SECRET_NAME_DEV;
  process.env.FLEET_FINANCE_COMPANY_MAP = '{"1":3}';
  process.env.FLEET_FINANCE_SERVICE_TOKEN = token;
  process.env.FLEET_FINANCE_WRITE_ENABLED = "true";
  process.env.CENTRAL_FINANCE_WRITE_ENABLED = "true";
  process.env.CENTRAL_FINANCE_SERVICE_TOKEN = token;
  const app = express(); app.use(express.json());
  app.use("/api/integrations/fleet",req(path.join(scratch,"receiver.cjs")).default);
  server = app.listen(0,"127.0.0.1");
  await new Promise((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject)});
  const base = "http://127.0.0.1:" + server.address().port;
  process.env.CENTRAL_FINANCE_BASE_URL=base;
  await build({entryPoints:[path.join(fleetRepo,"apps/api/src/lib/central-finance-client.ts")],outfile:path.join(scratch,"fleet-client.cjs"),platform:"node",target:"node22",format:"cjs",bundle:true,plugins:[{name:"block-real-fleet-db",setup(b){b.onResolve({filter:/^\.\/db$/},()=>({path:"no-db",namespace:"blocked"}));b.onLoad({filter:/.*/,namespace:"blocked"},()=>({contents:"export const pool = {query(){throw new Error('QA prohibited direct Fleet DB fallback')}};",loader:"js"}));}}],logLevel:"silent"});
  const fleet=req(path.join(scratch,"fleet-client.cjs"));
  async function http(endpoint,body,key,method="POST",auth=token){
    const r=await fetch(base+"/api/integrations/fleet"+endpoint,{method,headers:{"Content-Type":"application/json",Authorization:"Bearer "+auth,...(key?{"Idempotency-Key":key}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json()};
  }
  const scopeBody = p=>({...p,companyId:3,sourceCompanyId:1});
  const event = p=>"fleet-cash-payment:1:"+p.paymentId;
  const settings={companyId:1,fleetCashAccountId:49187,fleetDriverReceivableAccountId:49191,journalId:20};
  await test("QA role is non-superuser/non-bypass with target-company restriction",async()=>{
    const r=(await apiPool.query("SELECT current_user role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.equal(r.rolsuper,false);assert.equal(r.rolbypassrls,false);proof.role=r;
    const c=(await apiPool.query("SELECT company_id FROM public.accounting_settings ORDER BY company_id")).rows.map(r=>r.company_id);
    assert.deepEqual(c,[3]);
  });
  await test("configured target missing Fleet accounts fails before any journal",async()=>{
    await rejects(fleet.getFleetAccountingSettings(1),/belum dikonfigurasi/);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries")).n,0);
  });
  await test("actual client settings GET and readiness resolve source1 to Diva3",async()=>{
    await admin.query("UPDATE public.accounting_settings SET fleet_cash_account_id=49187,fleet_driver_receivable_account_id=49191,cash_journal_id=20 WHERE company_id=3");
    const b=await fleet.getFleetAccountingSettings(1);
    assert.equal(b.companyId,3);assert.equal(b.sourceCompanyId,1);
    assert.equal(b.journalId,20);assert.equal(b.fleetCashAccountId,49187);assert.equal(b.fleetDriverReceivableAccountId,49191);
    assert.equal(b.receiverWriteEnabled,true);assert.equal(b.receiverWriteReady,true);
    assert.deepEqual((await scalar("SELECT fleet_cash_account_id cash,fleet_driver_receivable_account_id ar,cash_journal_id journal FROM public.accounting_settings WHERE company_id=1")),{cash:49097,ar:49101,journal:6});
  });
  await test("dedicated runtime rejects settings PUT with controlled403 and no settings mutation",async()=>{
    const before=await scalar("SELECT to_jsonb(s) value FROM public.accounting_settings s WHERE company_id=3");
    const response=await http("/companies/3/accounting-settings",{...settings,companyId:3,sourceCompanyId:1},"qa-settings-read-only","PUT");
    assert.equal(response.status,403);
    assert.deepEqual(await scalar("SELECT to_jsonb(s) value FROM public.accounting_settings s WHERE company_id=3"),before);
  });
  await test("wrong token is401",async()=>assert.equal((await http("/cash-payments",scopeBody(primary),event(primary),"POST","bad-qa-token")).status,401));
  await test("missing/wrong source and wrong destination reject403",async()=>{
    for(const body of [{...scopeBody(primary),sourceCompanyId:undefined},{...scopeBody(primary),sourceCompanyId:2},{...scopeBody(primary),companyId:1}]) assert.equal((await http("/cash-payments",body,event(primary))).status,403);
  });
  await test("writer OFF rejects503 without SQL posting",async()=>{
    process.env.FLEET_FINANCE_WRITE_ENABLED="false";
    assert.equal((await http("/cash-payments",scopeBody(primary),event(primary))).status,503);
    process.env.FLEET_FINANCE_WRITE_ENABLED="true";
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries")).n,0);
  });
  await test("source amount/date/reference and forged idempotency conflicts reject409",async()=>{
    for(const extra of [{amount:primary.amount+1},{paymentDate:"2026-11-16"},{referenceNo:"forged"}]) assert.equal((await http("/cash-payments",{...scopeBody(primary),...extra},event(primary))).status,409);
    assert.equal((await http("/cash-payments",scopeBody(primary),"fleet-cash-payment:3:"+primary.paymentId)).status,409);
    assert.equal((await http("/cash-payments",{...scopeBody(primary),paymentId:990117399},"fleet-cash-payment:1:990117399")).status,409);
  });
  await test("settings GET and posting preflight reject wrong-company/header/nonpostable/inactive/non-asset accounts",async()=>{
    try {
      for(const cash of [49097,900001,900002,900003,900004]){
        await admin.query("UPDATE public.accounting_settings SET fleet_cash_account_id=$1 WHERE company_id=3",[cash]);
        await rejects(fleet.getFleetAccountingSettings(1),/COA/);
        await rejects(fleet.postFleetCashPayment(blocked),/COA/);
      }
      await admin.query("UPDATE public.accounting_settings SET fleet_cash_account_id=49187 WHERE company_id=3");
      for(const journal of [6,21]){
        await admin.query("UPDATE public.accounting_settings SET cash_journal_id=$1 WHERE company_id=3",[journal]);
        await rejects(fleet.getFleetAccountingSettings(1),/Jurnal/);
        await rejects(fleet.postFleetCashPayment(blocked),/Jurnal/);
      }
    }finally{await admin.query("UPDATE public.accounting_settings SET fleet_cash_account_id=49187,cash_journal_id=20 WHERE company_id=3")}
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries")).n,0);
  });
  await test("non-numeric, non-finite, and fractional-cent amounts reject400",async()=>{
    for(const amount of [true,false,"12500.25",null,12500.251]) assert.equal((await http("/cash-payments",{...scopeBody(primary),amount},event(primary))).status,400);
  });
  await test("inactive Diva blocks settings and new posting",async()=>{
    await admin.query("UPDATE public.companies SET is_active=false WHERE id=3");
    await rejects(fleet.getFleetAccountingSettings(1),/Perusahaan/);
    assert.equal((await http("/cash-payments",scopeBody(primary),event(primary))).status,409);
    await admin.query("UPDATE public.companies SET is_active=true WHERE id=3");
  });
  await test("denied derived-ledger INSERT rejects new payment and rolls back the entire transaction",async()=>{
    proof.postLedgerDenied=await deniedLedgerInsert(()=>http("/cash-payments",scopeBody(primary),event(primary)));
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries")).n,0);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entry_lines")).n,0);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.fleet_ledger_entries")).n,0);
  });
  let first;
  await test("real committed payment posts balanced entry+lines+derived ledger ONLY company3",async()=>{
    first=await fleet.postFleetCashPayment(primary);
    assert.equal(first.idempotent,false);assert.equal(first.companyId,3);assert.equal(first.sourceCompanyId,1);
    const e=await scalar("SELECT company_id,status::text,entry_status,source_event_id,total_debit::text,total_credit::text FROM public.accounting_entries WHERE id=$1",[first.entryId]);
    assert.deepEqual(e,{company_id:3,status:"posted",entry_status:"POSTED",source_event_id:event(primary),total_debit:"12500.25",total_credit:"12500.25"});
    const lines=(await admin.query("SELECT company_id,account_id,debit::text,credit::text FROM public.accounting_entry_lines WHERE entry_id=$1 ORDER BY id",[first.entryId])).rows;
    assert.deepEqual(lines,[{company_id:3,account_id:49187,debit:"12500.25",credit:"0.00"},{company_id:3,account_id:49191,debit:"0.00",credit:"12500.25"}]);
    const ledger=await scalar("SELECT count(*)::int n,min(company_id) min_company,max(company_id) max_company,sum(debit)::text debit,sum(credit)::text credit FROM public.fleet_ledger_entries WHERE source_type='fleet_cash_payment' AND source_id=$1",[primary.paymentId]);
    assert.equal(ledger.n,2);assert.equal(ledger.min_company,3);assert.equal(ledger.max_company,3);assert.equal(Number(ledger.debit),primary.amount);assert.equal(Number(ledger.credit),primary.amount);
    const same=await scalar("SELECT count(*)::int source_rows,md5(string_agg(to_jsonb(p)::text,',' ORDER BY id)) source_hash FROM public.fleet_cash_payments p");
    assert.deepEqual(same,baseline);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries WHERE company_id<>3")).n,0);
    proof.payment={entryId:first.entryId,companyId:3,sourceCompanyId:1,lines:2,derivedLedgerLines:2};
  });
  await test("real replay returns same entry without new rows",async()=>{
    const r=await fleet.postFleetCashPayment(primary);assert.equal(r.idempotent,true);assert.equal(r.entryId,first.entryId);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries WHERE source='fleet_cash_payment' AND source_id=$1",[primary.paymentId])).n,1);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.fleet_ledger_entries WHERE source_type='fleet_cash_payment' AND source_id=$1",[primary.paymentId])).n,2);
  });
  await test("payment replay rejects derived ledger rows hidden by its access policy",async()=>{
    proof.paymentLedgerVisibility=await hiddenLedgerReplay("fleet_cash_payment",primary.paymentId,()=>http("/cash-payments",scopeBody(primary),event(primary)));
    const restored=await fleet.postFleetCashPayment(primary);assert.equal(restored.idempotent,true);assert.equal(restored.entryId,first.entryId);
  });
  await test("historical journal reassigned to another company rejects replay",async()=>{
    await admin.query("UPDATE public.accounting_journals SET company_id=1 WHERE id=20");
    await rejects(fleet.postFleetCashPayment(primary),/Jurnal/);
    await admin.query("UPDATE public.accounting_journals SET company_id=3 WHERE id=20");
    const r=await fleet.postFleetCashPayment(primary);assert.equal(r.idempotent,true);assert.equal(r.entryId,first.entryId);
  });
  await test("eight parallel deliveries commit once, seven idempotent replays",async()=>{
    const out=await Promise.all(Array.from({length:8},()=>fleet.postFleetCashPayment(parallel)));
    assert.equal(new Set(out.map(r=>r.entryId)).size,1);assert.equal(out.filter(r=>!r.idempotent).length,1);assert.equal(out.filter(r=>r.idempotent).length,7);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries WHERE source='fleet_cash_payment' AND source_id=$1",[parallel.paymentId])).n,1);
    proof.parallel={requests:8,created:1,replayed:7,entryId:out[0].entryId};
  });
  await test("posted journal and generated ledger remain immutable",async()=>{
    await rejects(admin.query("UPDATE public.accounting_entries SET total_debit=1 WHERE id=$1",[first.entryId]),/IMMUTAB/i);
    await rejects(admin.query("DELETE FROM public.accounting_entries WHERE id=$1",[first.entryId]),/IMMUTAB/i);
    await rejects(admin.query("DELETE FROM public.fleet_ledger_entries WHERE source_type='fleet_cash_payment' AND source_id=$1",[primary.paymentId]),/IMMUTAB/i);
  });
  await test("closed accounting period rejects and rolls back all candidate rows",async()=>{
    await rejects(fleet.postFleetCashPayment(closed),/PERIOD_LOCK|PERIOD LOCK/);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries WHERE source_id=$1",[closed.paymentId])).n,0);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.fleet_ledger_entries WHERE source_id=$1",[closed.paymentId])).n,0);
  });
  await test("invalid current account/journal configuration blocks new payment",async()=>{
    await admin.query("UPDATE public.accounting_settings SET cash_journal_id=6 WHERE company_id=3");
    await rejects(fleet.postFleetCashPayment(blocked),/Jurnal/);
    await admin.query("UPDATE public.accounting_settings SET cash_journal_id=20,fleet_cash_account_id=900001 WHERE company_id=3");
    await rejects(fleet.postFleetCashPayment(blocked),/COA/);
    await admin.query("UPDATE public.accounting_settings SET fleet_cash_account_id=49187 WHERE company_id=3");
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries WHERE source_id=$1",[blocked.paymentId])).n,0);
  });
  const originalBefore=await scalar("SELECT to_jsonb(e) value FROM public.accounting_entries e WHERE id=$1",[first.entryId]);
  await admin.query("UPDATE public.fleet_cash_payments SET status='posted',accounting_entry_id=$2 WHERE id=$1",[primary.paymentId,first.entryId]);
  let reversal;
  await test("inactive Diva blocks existing payment replay and reversal",async()=>{
    await admin.query("UPDATE public.companies SET is_active=false WHERE id=3");
    await rejects(fleet.postFleetCashPayment(primary),/Perusahaan/);
    await rejects(fleet.reverseFleetCashPayment({...primary,originalEntryId:first.entryId}),/Perusahaan/);
    await admin.query("UPDATE public.companies SET is_active=true WHERE id=3");
  });
  await test("reversal rejects wrong original and mismatched amount",async()=>{
    await rejects(fleet.reverseFleetCashPayment({...primary,originalEntryId:first.entryId+1000}),/asal/);
    await rejects(fleet.reverseFleetCashPayment({...primary,originalEntryId:first.entryId,amount:primary.amount+1}),/Bukti pembayaran/);
  });
  await test("denied derived-ledger INSERT rejects reversal and preserves original payment/journal",async()=>{
    proof.reversalLedgerDenied=await deniedLedgerInsert(()=>http("/cash-payments/reverse",{...scopeBody(primary),originalEntryId:first.entryId},"fleet-cash-payment-reversal:1:"+primary.paymentId+":"+first.entryId));
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries WHERE source='reversal' AND source_id=$1",[first.entryId])).n,0);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.fleet_ledger_entries WHERE source_type='reversal' AND source_id=$1",[first.entryId])).n,0);
    assert.deepEqual(await scalar("SELECT to_jsonb(e) value FROM public.accounting_entries e WHERE id=$1",[first.entryId]),originalBefore);
  });
  await test("reversal uses original accounts despite later settings change",async()=>{
    await admin.query("UPDATE public.accounting_settings SET fleet_cash_account_id=49192 WHERE company_id=3");
    reversal=await fleet.reverseFleetCashPayment({...primary,originalEntryId:first.entryId});
    assert.equal(reversal.idempotent,false);assert.equal(reversal.companyId,3);
    const lines=(await admin.query("SELECT account_id,debit::text,credit::text,company_id FROM public.accounting_entry_lines WHERE entry_id=$1 ORDER BY account_id",[reversal.entryId])).rows;
    assert.deepEqual(lines,[{account_id:49187,debit:"0.00",credit:"12500.25",company_id:3},{account_id:49191,debit:"12500.25",credit:"0.00",company_id:3}]);
    assert.deepEqual(await scalar("SELECT to_jsonb(e) value FROM public.accounting_entries e WHERE id=$1",[first.entryId]),originalBefore);
    proof.reversal={entryId:reversal.entryId,originalEntryId:first.entryId,originalUnchanged:true,originalAccountsReused:true};
  });
  await test("reversal replay rejects derived ledger rows hidden by its access policy",async()=>{
    proof.reversalLedgerVisibility=await hiddenLedgerReplay("reversal",first.entryId,()=>http("/cash-payments/reverse",{...scopeBody(primary),originalEntryId:first.entryId},"fleet-cash-payment-reversal:1:"+primary.paymentId+":"+first.entryId));
    const restored=await fleet.reverseFleetCashPayment({...primary,originalEntryId:first.entryId});assert.equal(restored.idempotent,true);assert.equal(restored.entryId,reversal.entryId);
  });
  await test("parallel reversal replays and cancelled source replay stay idempotent",async()=>{
    const out=await Promise.all(Array.from({length:5},()=>fleet.reverseFleetCashPayment({...primary,originalEntryId:first.entryId})));
    assert.ok(out.every(r=>r.idempotent&&r.entryId===reversal.entryId));
    await admin.query("UPDATE public.fleet_cash_payments SET status='cancelled' WHERE id=$1",[primary.paymentId]);
    const r=await fleet.reverseFleetCashPayment({...primary,originalEntryId:first.entryId});assert.equal(r.idempotent,true);assert.equal(r.entryId,reversal.entryId);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.accounting_entries WHERE source='reversal' AND source_id=$1",[first.entryId])).n,1);
  });
  await test("all journals and ledger lines retain Diva company3; source company1 retained",async()=>{
    const rows=(await admin.query("SELECT company_id,source::text,count(*)::int n FROM public.accounting_entries GROUP BY company_id,source ORDER BY source")).rows;
    assert.ok(rows.every(r=>r.company_id===3));
    const ledger=await scalar("SELECT count(*)::int n,count(*) FILTER(WHERE company_id<>3)::int wrong_company FROM public.fleet_ledger_entries");
    assert.equal(ledger.wrong_company,0);assert.equal(ledger.n,6);
    assert.equal((await scalar("SELECT count(*)::int n FROM public.fleet_cash_payments WHERE company_id<>1")).n,0);
    proof.final={journals:rows,ledger,sourceRows:baseline.source_rows};
  });
  process.stdout.write(JSON.stringify({ok:true,testsPassed:passed.length,proof},null,2)+"\n");
} catch(error) {
  process.stderr.write(JSON.stringify({ok:false,testsPassed:passed.length,error:String(error?.stack||error)})+"\n");
  process.exitCode=1;
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  await apiPool.end();await admin.end();
  delete globalThis.__fleetFinanceQaConnect;
  if(scratch)await rm(scratch,{recursive:true,force:true});
}
