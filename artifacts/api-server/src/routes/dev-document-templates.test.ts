import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
const mocked=vi.hoisted(()=>({query:vi.fn(),auth:vi.fn(),dev:vi.fn(),connect:vi.fn(),txQuery:vi.fn(),release:vi.fn(),role:"super_admin",companyId:1 as number|null}));
vi.mock("@workspace/db",()=>({pool:{query:mocked.query,connect:mocked.connect}}));
vi.mock("./dev-auth",()=>({isDevelopmentEnvironment:mocked.dev}));
vi.mock("./admin-auth",()=>({authenticateAdmin:mocked.auth}));
import router from "./dev-document-templates";
let server:Server;let base:string;
const CST={id:1,company_name:"PT Cahaya Sejati Teknologi",name:"PT Cahaya Sejati Teknologi",
  company_code:"CST",logo_url:"https://dev-bizportal.cstlogistic.co.id/cst-logo.png",
  address:"Jalan Ternate No. 10B",phone:"087808785098",email:"cahayasejatiteknologi@gmail.com"};
beforeAll(async()=>{
  const app=express();app.use(express.json());app.use("/api",router);
  server=app.listen(0);await new Promise<void>(resolve=>server.once("listening",resolve));
  base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
beforeEach(()=>{
  vi.clearAllMocks();mocked.dev.mockReturnValue(true);mocked.role="super_admin";mocked.companyId=1;
  mocked.connect.mockResolvedValue({query:mocked.txQuery,release:mocked.release});
  mocked.txQuery.mockImplementation(async (sql:string,params?:unknown[])=>{
    if(sql.includes("select value from public.app_config"))return {rows:[{value:JSON.stringify({documentType:"invoice",headerText:"DEV_VERIFICATION",primaryColor:"#1e3a6e"})}]};
    return {rows:[]};
  });
  mocked.auth.mockImplementation(async (req,res,next)=>{
    if(req.headers.authorization!=="Bearer verified"){res.status(401).json({error:"Unauthorized"});return;}
    req.adminUser={id:"user-1",email:"admin@test.dev",role:mocked.role,companyId:mocked.companyId};next();
  });
  mocked.query.mockImplementation(async(sql:string)=>{
    if(sql.includes("from public.companies"))return {rows:[CST]};
    if(sql.includes("returning value,updated_at"))return {rows:[{value:JSON.stringify({headerText:"Header Baru"}),updated_at:"2026-11-13T00:00:00Z"}]};
    if(sql.includes("from public.app_config"))return {rows:[]};
    return {rows:[]};
  });
});
const url=(s="")=>base+"/api/settings/documents"+s;
const headers={authorization:"Bearer verified"};
describe("existing DEV document template API",()=>{
  it("fails closed outside DEV",async()=>{
    mocked.dev.mockReturnValue(false);
    const r=await fetch(url("?companyId=1"),{headers});
    expect(r.status).toBe(404);expect(mocked.query).not.toHaveBeenCalled();
  });
  it("rejects anonymous users before reading database",async()=>{
    const r=await fetch(url("?companyId=1"));
    expect(r.status).toBe(401);expect(mocked.query).not.toHaveBeenCalled();
  });
  it("enforces company selection and session company scope",async()=>{
    expect((await fetch(url(),{headers})).status).toBe(200);
    expect((await fetch(url("?companyId=2"),{headers})).status).toBe(403);
    expect((await fetch(url("?companyId=not-an-id"),{headers})).status).toBe(400);
  });
  it("denies admin/finance without company binding before reading database",async()=>{
    for(const role of ["admin","finance","accounting"]){
      mocked.role=role;mocked.companyId=null;mocked.query.mockClear();
      const r=await fetch(url("?companyId=2"),{headers});
      expect(r.status).toBe(403);
      expect((await r.json() as {code:string}).code).toBe("COMPANY_SCOPE_MISSING");
      expect(mocked.query).not.toHaveBeenCalled();
    }
  });
  it("rejects cross-company access before querying",async()=>{
    mocked.role="finance";mocked.companyId=1;mocked.query.mockClear();
    const r=await fetch(url("?companyId=2"),{headers});
    expect(r.status).toBe(403);
    expect((await r.json() as {code:string}).code).toBe("COMPANY_SCOPE_MISMATCH");
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("permits a verified unscoped owner to select company explicitly",async()=>{
    mocked.role="owner";mocked.companyId=null;
    expect((await fetch(url("?companyId=1"),{headers})).status).toBe(200);
  });
  it("loads all existing document types without inserting new data",async()=>{
    const r=await fetch(url("?companyId=1"),{headers});expect(r.status).toBe(200);
    const data=await r.json() as Array<Record<string,unknown>>;
    expect(data).toHaveLength(10);
    for(const type of ["invoice","po","delivery_note","manifest","quotation","kontrak"]){
      expect(data.some(x=>x.documentType===type)).toBe(true);
    }
    const invoice=data.find(x=>x.documentType==="invoice")!;
    expect(invoice.logoUrl).toContain("cst-logo.png");
    expect(String(invoice.companyAddress)).toContain("GEDUNG SPORT CENTER");
    expect(String(invoice.companyAddress)).not.toContain("Ternate");
    expect(mocked.query.mock.calls.every(c=>!String(c[0]).includes("insert"))).toBe(true);
  });
  it("requires a verified Super Admin session for rollback-only diagnostic",async()=>{
    const unauth=await fetch(url("/verify?companyId=1"),{method:"POST"});
    expect(unauth.status).toBe(401);
    expect(mocked.connect).not.toHaveBeenCalled();
    mocked.role="finance";
    const finance=await fetch(url("/verify?companyId=1"),{method:"POST",headers});
    expect(finance.status).toBe(403);
    expect(mocked.connect).not.toHaveBeenCalled();
  });
  it("checks live read/write/read and rolls back without affecting saved documents",async()=>{
    const r=await fetch(url("/verify?companyId=1"),{method:"POST",headers});
    expect(r.status).toBe(200);
    const result=await r.json() as {ok:boolean;checks:Record<string,boolean>;documentIssued:boolean;pdfPrintedInBrowser:boolean};
    expect(result.ok).toBe(true);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.documentIssued).toBe(false);
    expect(result.pdfPrintedInBrowser).toBe(false);
    const calls=mocked.txQuery.mock.calls.map(x=>String(x[0]));
    expect(calls[0]).toBe("BEGIN");
    expect(calls.some(sql=>sql.includes("insert into public.app_config"))).toBe(true);
    expect(calls.some(sql=>sql.includes("select value from public.app_config"))).toBe(true);
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(mocked.release).toHaveBeenCalledOnce();
    expect(calls.some(sql=>/mkt_purchase_orders|mkt_rfqs|accounting/i.test(sql))).toBe(false);
  });
  it("fails closed and rolls back if diagnostic roundtrip is inconsistent",async()=>{
    mocked.txQuery.mockImplementation(async (sql:string)=>{
      if(sql.includes("select value from public.app_config"))return {rows:[{value:"INCORRECT"}]};
      return {rows:[]};
    });
    const r=await fetch(url("/verify?companyId=1"),{method:"POST",headers});
    expect(r.status).toBe(503);
    expect(mocked.txQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(mocked.release).toHaveBeenCalledOnce();
  });
  it("saves only the selected type and company, idempotently",async()=>{
    const r=await fetch(url("/invoice?companyId=1"),{
      method:"PATCH",headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify({documentType:"invoice",headerText:"Header Baru",showTax:true,fontSize:11}),
    });
    expect(r.status).toBe(200);
    const sql=mocked.query.mock.calls.find(c=>String(c[0]).includes("insert into public.app_config"));
    expect(sql).toBeDefined();
    expect(sql![1][0]).toBe("bizportal_dev_document_template_v1:1:invoice");
    expect(JSON.parse(sql![1][1]).headerText).toBe("Header Baru");
    expect(String(sql![0])).toContain("on conflict (key)");
  });
  it("loads the same saved configuration on repeated GET without duplicate writes",async()=>{
    let persisted:string|undefined;let writeCount=0;
    mocked.query.mockImplementation(async (sql:string,args?:unknown[])=>{
      if(sql.includes("from public.companies"))return {rows:[CST]};
      if(sql.includes("insert into public.app_config")){
        writeCount++;persisted=String(args?.[1]);
        return {rows:[{value:persisted,updated_at:"2026-11-13T12:00:00Z"}]};
      }
      if(sql.includes("from public.app_config")&&sql.includes("key=$1")){
        return {rows:persisted?[{value:persisted,updated_at:"2026-11-13T12:00:00Z"}]:[]};
      }
      return {rows:[]};
    });
    const body=JSON.stringify({documentType:"po",headerText:"PO CST",primaryColor:"#1e3a6e"});
    for(let i=0;i<2;i++){
      const saved=await fetch(url("/po?companyId=1"),{method:"PATCH",headers:{...headers,"content-type":"application/json"},body});
      expect(saved.status).toBe(200);
      const loaded=await fetch(url("/po?companyId=1"),{headers});
      expect(loaded.status).toBe(200);
      const config=await loaded.json() as Record<string,unknown>;
      expect(config.headerText).toBe("PO CST");
      expect(config.companyAddress).toContain("GEDUNG SPORT CENTER");
    }
    expect(writeCount).toBe(2); // idempotent upsert to same key, never new transaction
    const sqlCall=mocked.query.mock.calls.find(c=>String(c[0]).includes("insert into public.app_config"));
    expect(String(sqlCall?.[0])).toContain("on conflict (key)");
  });
  it("refuses invalid payloads before writes",async()=>{
    for(const payload of [{documentType:"invoice",primaryColor:"red"},{documentType:"po",logoUrl:"x"},{documentType:"invoice",fontSize:200}]){
      const r=await fetch(url("/invoice?companyId=1"),{
        method:"PATCH",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(payload),
      });
      expect(r.status).toBe(400);
    }
    expect(mocked.query.mock.calls.some(c=>String(c[0]).includes("insert"))).toBe(false);
  });
  it.each(["invoice","po","delivery_note","manifest","kontrak"] as const)("previews centered %s with CST logo and print CSS, no database writes",(async type=>{
    const r=await fetch(url("/"+type+"/preview?companyId=1"),{
      method:"POST",headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify({documentType:type,footerText:"Selesai",primaryColor:"#1e3a6e"}),
    });
    expect(r.status).toBe(200);
    const html=await r.text();
    expect(html).toContain("text-align:center");
    expect(html).toContain("@page{size:A4");
    expect(html).toContain("cst-logo.png");
    expect(html).toContain("src=\'/cst-logo.png\'");
    expect(html).toContain("grid-template-columns:132px minmax(0,1fr)");
    expect(html).toContain("brand-rule-accent");
    expect(r.headers.get("content-security-policy")).toContain("img-src \'self\' https: data:");
    expect(html).toContain("GEDUNG SPORT CENTER");
    expect(html).toContain("BUKAN DOKUMEN TRANSAKSI");
    expect(mocked.query.mock.calls.some(c=>String(c[0]).includes("insert"))).toBe(false);
  }));
});
