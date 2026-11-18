import express from 'express';
import type {Server} from 'node:http';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const boundary=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('@workspace/db',()=>({pool:{query:boundary.query}}));
import {createDevAuthRouter,isSignedOtpDevEnabled,getDevSession} from './dev-auth';
import {authenticateAdmin} from './admin-auth';
import type {Request} from 'express';

let server:Server,base:string;
beforeAll(async()=>{
 const app=express();app.use(express.json());app.use(createDevAuthRouter());
 app.get('/protected',authenticateAdmin,(_req,res)=>res.json({authorized:true}));
 server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const addr=server.address();if(!addr||typeof addr==='string')throw Error('LOCAL_TEST_LISTENER_REQUIRED');
 base='http://127.0.0.1:'+addr.port;
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
beforeEach(()=>{
 vi.stubEnv('APP_ENV','development');vi.stubEnv('NODE_ENV','test');
 vi.stubEnv('BIZPORTAL_SIGNED_OTP_ENABLED_DEV','false');vi.stubEnv('BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV','false');
 vi.stubEnv('SESSION_SECRET','synthetic-local-only-signing-material-longer-than-32');
 vi.stubEnv('BIZPORTAL_SESSION_SECRET','');vi.stubEnv('DEV_LOGIN_EMAILS','fixture@example.test');
 vi.stubEnv('DEV_LOGIN_ROLE','admin');boundary.query.mockReset();
 boundary.query.mockRejectedValue(Error('NO_REAL_DB_ALLOWED_IN_CLOSURE_TEST'));
});
afterEach(()=>vi.unstubAllEnvs());
async function legacyLogin(){return fetch(base+'/auth/dev-login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});}

describe('existing signed DEV mode closes legacy email-only login',()=>{
 it('preserves the explicit legacy-only test mode when both signed flags are OFF',async()=>{
  const r=await legacyLogin();expect(r.status).toBe(200);
  const cookie=r.headers.get('set-cookie')!.split(';')[0]!;
  expect((await fetch(base+'/auth/user',{headers:{cookie}})).status).toBe(200);
  expect(boundary.query).not.toHaveBeenCalled();
 });
 it.each([
  ['OTP',true,false,true],['OTP missing signing key',true,false,false],
  ['password request',false,true,true],['password request missing key',false,true,false],
  ['conflicting signed modes',true,true,true],['conflicting signed modes missing key',true,true,false],
 ] as const)('closes legacy login/list and existing legacy cookie for %s',async(_name,otp,password,hasKey)=>{
  // This cookie comes from the unmodified local test endpoint, not an OTP or
  // real user's session. No production cookie or database identity is created.
  const before=await legacyLogin();expect(before.status).toBe(200);
  const cookie=before.headers.get('set-cookie')!.split(';')[0]!;
  vi.stubEnv('BIZPORTAL_SIGNED_OTP_ENABLED_DEV',String(otp));
  vi.stubEnv('BIZPORTAL_SIGNED_PASSWORD_ENABLED_DEV',String(password));
  if(!hasKey)vi.stubEnv('SESSION_SECRET','');
  const list=await fetch(base+'/auth/dev-users');expect(list.status).toBe(404);
  expect(await list.text()).not.toContain('fixture@example.test');
  const login=await legacyLogin();expect(login.status).toBe(404);expect(login.headers.get('set-cookie')).toBeNull();
  expect(getDevSession({headers:{cookie}} as Request)).toBeNull();
  expect((await fetch(base+'/protected',{headers:{cookie}})).status).toBe(401);
  // This router alone delegates absent profiles to next(); the minimal test
  // app has no downstream profile handler, so fallthrough is precisely 404.
  expect((await fetch(base+'/auth/user',{headers:{cookie}})).status).toBe(404);
  expect((await fetch(base+'/users/me',{headers:{cookie}})).status).toBe(404);
  expect(boundary.query).not.toHaveBeenCalled();
  expect(isSignedOtpDevEnabled()).toBe(otp&&!password&&hasKey);
 });
 it('does not enable DEV identity endpoints when APP_ENV selects production',async()=>{
  vi.stubEnv('APP_ENV','production');vi.stubEnv('BIZPORTAL_SIGNED_OTP_ENABLED_DEV','true');
  expect((await fetch(base+'/auth/dev-users')).status).toBe(404);
  expect((await legacyLogin()).status).toBe(404);expect(isSignedOtpDevEnabled()).toBe(false);
  expect(boundary.query).not.toHaveBeenCalled();
 });
});
