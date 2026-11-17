#!/usr/bin/env node
/* Authorized DEV host counterpart. Secrets remain in memory or root-only storage.
 * Reads the existing DEV issuer connection without copying it into Finance.
 * prepare/check are non-mutating to the DB; install requires dormant exact roles.
 */
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process'),tls=require('node:tls'),path=require('node:path');
const {Pool}=require('../node_modules/pg');
const PROJECT='xssrfshdrtdfupgqwfdw',DIR='/run/bizportal-invoice-custody-20261117';
const STORAGE='/etc/bizportal-finance-dev/vendor-storage-dev.env';
const AAD=Buffer.from('bizportal-dev-finance-custody-20261117:'+PROJECT);
const ROLES={1:'bizportal_finance_cst_login_dev',3:'bizportal_finance_diva_login_dev'};
const fail=(ok,code)=>{if(!ok)throw new Error(code)};
const ca=fs.readFileSync(path.join(__dirname,'../lib/db/src/supabase-finance-root-2021.ts'),'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0];
fail(new crypto.X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase()==='807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa','CA_PIN_MISMATCH');
function pool(raw,role){
 const u=new URL(raw),direct=u.hostname==='db.'+PROJECT+'.supabase.co',pooled=u.hostname==='aws-1-ap-southeast-2.pooler.supabase.com';
 fail((direct&&decodeURIComponent(u.username)===role)||(pooled&&decodeURIComponent(u.username)===role+'.'+PROJECT),'DATABASE_IDENTITY_MISMATCH');
 fail(u.pathname==='/postgres'&&u.password,'DATABASE_PATH_MISMATCH');
 return new Pool({host:u.hostname,port:Number(u.port||5432),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'postgres',ssl:{rejectUnauthorized:true,servername:u.hostname,ca:[...tls.rootCertificates,ca]},max:1,connectionTimeoutMillis:12000,application_name:'bizportal-finance-custody-dev'});
}
function admin(){
 const pid=cp.execFileSync('systemctl',['show','cst-bizportal-gmail-dev.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
 fail(/^\d+$/.test(pid)&&pid!=='0','DEV_ISSUER_NOT_RUNNING');
 const env=Object.fromEntries(fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0').filter(x=>x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
 return pool(env.SUPABASE_DATABASE_URL_DEV,'postgres');
}
async function baseline(c){
 fail((await c.query('select current_user,session_user,current_database() as database')).rows.every(r=>r.current_user==='postgres'&&r.session_user==='postgres'&&r.database==='postgres'),'ADMIN_IDENTITY_MISMATCH');
 const roles=(await c.query('select rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolconnlimit from pg_roles where rolname=ANY($1) order by rolname',[Object.values(ROLES)])).rows;
 fail(roles.length===2&&roles.every(r=>!r.rolcanlogin&&!r.rolinherit&&!r.rolsuper&&!r.rolbypassrls&&!r.rolcreatedb&&!r.rolcreaterole&&r.rolconnlimit===0),'COMPANY_ROLES_NOT_DORMANT');
 const fingerprint=(await c.query("select count(*)::int as count,md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''),E'\\n' order by tablename,policyname,cmd)) as hash from pg_policies where schemaname='public' and policyname='pr107_company_role_restrictive_all'")).rows[0];
 fail(fingerprint.count===11&&fingerprint.hash==='5c1a4a2a782cf1d82e786061f5ef8e21','COMPANY_RLS_CHANGED');
 const lock=(await c.query("select md5(p.prosrc) as hash, r.rolname,r.rolcanlogin,r.rolsuper,r.rolbypassrls,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='finance_ops_private' and p.proname='mkt_finance_lock_vendor_invoice_parents_dev'")).rows;
 fail(lock.length===1&&lock[0].hash==='06d261a1ec4908c31b681d7a0f1f26cd'&&lock[0].rolname==='bizportal_finance_parent_lock_owner_dev'&&!lock[0].rolcanlogin&&!lock[0].rolsuper&&!lock[0].rolbypassrls&&lock[0].prosecdef,'PARENT_LOCK_CHANGED');
 fail((await c.query('select count(*)::int as count from pg_auth_members where member in(select oid from pg_roles where rolname=ANY($1))',[Object.values(ROLES)])).rows[0].count===0,'COMPANY_ROLE_MEMBERSHIP');
 for(const role of Object.values(ROLES))for(const table of ['mkt_purchase_orders','mkt_po_goods_receipts','mkt_po_shipments'])fail(!(await c.query("select has_any_column_privilege($1,$2,'UPDATE') as allowed",[role,'public.'+table])).rows[0].allowed,'PARENT_UPDATE_LEAK');
 return {project:PROJECT,dormantCompanyRoles:roles.length,companyPolicies:fingerprint.count,parentLock:true,verifiedTls:true};
}
function scram(password){
 const salt=crypto.randomBytes(16),salted=crypto.pbkdf2Sync(password,salt,4096,32,'sha256');
 const hmac=x=>crypto.createHmac('sha256',salted).update(x).digest();
 return 'SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+crypto.createHash('sha256').update(hmac('Client Key')).digest('base64')+':'+hmac('Server Key').toString('base64');
}
async function main(){
 fail(process.getuid()===0,'ROOT_REQUIRED');
 const op=process.argv[2];
 if(op==='prepare'){
  fs.mkdirSync(DIR,{mode:0o700});
  const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  fs.writeFileSync(DIR+'/private.pem',keys.privateKey,{mode:0o600,flag:'wx'});
  fs.writeFileSync(DIR+'/public.pem',keys.publicKey,{mode:0o644,flag:'wx'});
  console.log(JSON.stringify({recipientPublicKey:keys.publicKey,recipientSha256:crypto.createHash('sha256').update(keys.publicKey).digest('hex')}));return;
 }
 const p=admin(),c=await p.connect(); let enabled=false,wroteStorage=false;
 try{
  await c.query('begin');await c.query("set local statement_timeout='20000ms'");
  await c.query("select pg_advisory_xact_lock(hashtext('bizportal-finance-companies-provision-20261117'))");
  const facts=await baseline(c);
  if(op==='check'){await c.query('rollback');console.log(JSON.stringify(facts));return}
  fail(op==='install','INVALID_OPERATION');fail(!fs.existsSync(STORAGE),'STORAGE_ALREADY_CONFIGURED');
  const envelope=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),pem=fs.readFileSync(DIR+'/public.pem');
  fail(envelope.version===1&&envelope.recipientSha256===crypto.createHash('sha256').update(pem).digest('hex'),'ENVELOPE_RECIPIENT_MISMATCH');
  const key=crypto.privateDecrypt({key:fs.readFileSync(DIR+'/private.pem'),padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:AAD},Buffer.from(envelope.wrappedKey,'base64'));
  const sealed=Buffer.from(envelope.ciphertext,'base64'),decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'base64'));
  decipher.setAAD(AAD);decipher.setAuthTag(sealed.subarray(-16));
  const payload=JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0,-16)),decipher.final()]).toString());
  fail(payload.project===PROJECT&&payload.expires>Date.now()/1000&&payload.expires<Date.now()/1000+7300,'ENVELOPE_EXPIRED_OR_PROJECT');
  fail(payload.bundle.version===1&&Object.keys(payload.bundle.companies).sort().join(',')==='1,3','BUNDLE_INVALID');
  fail(Object.keys(payload.storage).sort().join(',')==='SUPABASE_SERVICE_ROLE_KEY_DEV,SUPABASE_URL_DEV'&&payload.storage.SUPABASE_URL_DEV.replace(/\/$/,'')==='https://'+PROJECT+'.supabase.co','STORAGE_PROJECT_MISMATCH');
  for(const [id,role]of Object.entries(ROLES)){
   const item=payload.bundle.companies[id];fail(item.role===role,'BUNDLE_ROLE_MISMATCH');
   const u=new URL(item.databaseUrl);fail(u.hostname==='db.'+PROJECT+'.supabase.co'&&u.username===role&&u.password.length>=60,'BUNDLE_URL_MISMATCH');
   const verifier=scram(decodeURIComponent(u.password));
   fail(/^[A-Za-z0-9+/=:$-]+$/.test(verifier),'VERIFIER_INVALID');
   await c.query('alter role '+role+" login connection limit 4 password '"+verifier+"'");
  }
  await c.query('commit');enabled=true;
  const results=[];
  for(const[id,role]of Object.entries(ROLES)){
   const scoped=pool(payload.bundle.companies[id].databaseUrl,role);
   try{
    await scoped.query('begin read only');await scoped.query("select set_config('app.marketplace_company_id',$1,true)",[id]);
    const identity=(await scoped.query('select current_user,session_user')).rows[0];fail(identity.current_user===role&&identity.session_user===role,'LOGIN_IDENTITY_FAILED');
    const visible=(await scoped.query('select id,company_id from public.mkt_purchase_orders')).rows;fail(visible.every(r=>r.company_id===Number(id)),'OWN_COMPANY_RLS_FAILED');
    await scoped.query("select set_config('app.marketplace_company_id',$1,true)",[id==='1'?'3':'1']);
    fail((await scoped.query('select count(*)::int as count from public.mkt_purchase_orders')).rows[0].count===0,'SPOOFED_COMPANY_RLS_FAILED');
    await scoped.query('rollback');results.push({companyId:Number(id),role,ownVisibleRows:visible.length,spoofedCompanyRows:0,tlsVerified:true});
   }finally{await scoped.end()}
  }
  const lines=Object.entries(payload.storage).map(([k,v])=>{fail(typeof v==='string'&&!/[\s"'\\$`]/.test(v),'STORAGE_VALUE_INVALID');return k+'='+v}).join('\n')+'\n';
  fs.writeFileSync(STORAGE,lines,{mode:0o600,flag:'wx'});wroteStorage=true;
  console.log(JSON.stringify({ok:true,project:PROJECT,secretVersion:payload.secretVersion,companySessions:results,storageCredentialInstalled:true,writerRuntimeChanged:false,secretsPrinted:false}));
  fs.unlinkSync(DIR+'/private.pem');fs.unlinkSync(process.argv[3]);
 }catch(error){
  await c.query('rollback').catch(()=>{});
  if(enabled){await c.query('begin');for(const role of Object.values(ROLES))await c.query('alter role '+role+' nologin connection limit 0 password null');await c.query('commit')}
  if(wroteStorage)fs.unlinkSync(STORAGE);
  throw error;
 }finally{c.release();await p.end()}
}
main().catch(e=>{const stable=/^[A-Z_]+$/.test(e.message)?e.message:(e.code||e.name);console.error(JSON.stringify({ok:false,code:stable}));process.exitCode=1});
