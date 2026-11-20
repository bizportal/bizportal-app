import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

type Entry = { id:number; company_id:number; source:string; source_id:number; status:string; debit:number; credit:number };
const state = vi.hoisted(() => ({
  queries: [] as string[],
  source: { id: 55, company_id: 3, status: "confirmed", amount: 100, payment_date: "2026-11-17" },
  entries: [] as Entry[],
  lines: [] as unknown[][],
  nextId: 900,
  journalCompany: 3,
}));
vi.mock("@workspace/db", () => ({
  pool: { connect: vi.fn(async () => ({
    query: async (sql: string, args: unknown[] = []) => {
      const q = String(sql).replace(/\\s+/g, " ").trim();
      state.queries.push(q);
      const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
      if (["BEGIN","COMMIT","ROLLBACK"].includes(q)) return rows([]);
      if (q.includes("FROM public.fleet_cash_payments")) {
        const [paymentId, companyId, amount, date] = args;
        const s = state.source;
        return rows(s.id === Number(paymentId) && s.company_id === Number(companyId)
          && s.amount === Number(amount) && (!date || s.payment_date === date)
          ? [{id:s.id,status:s.status}] : []);
      }
      if (q.includes("FROM public.accounting_settings")) {
        return rows([{fleet_cash_account_id:49187,fleet_driver_receivable_account_id:49191,journal_id:20}]);
      }
      if (q.includes("FROM public.chart_of_accounts")) return rows([{id:49187},{id:49191}]);
      if (q.includes("FROM public.accounting_journals")) {
        return rows(Number(args[1]) === state.journalCompany ? [{id:20}]:[]);
      }
      if (q.includes("FROM public.accounting_entries") && q.includes("source='fleet_cash_payment' AND source_id=$3")) {
        return rows(state.entries.filter(e=>e.id===Number(args[0]) && e.company_id===Number(args[1]) && e.source==="fleet_cash_payment" && e.source_id===Number(args[2]))
          .map(e=>({id:e.id,total_debit:e.debit,total_credit:e.credit,status:e.status})));
      }
      if (q.includes("FROM public.accounting_entries") && q.includes("source='fleet_cash_payment'")) {
        return rows(state.entries.filter(e=>e.company_id===Number(args[0])&&e.source==="fleet_cash_payment"&&e.source_id===Number(args[1]))
          .map(e=>({id:e.id,status:e.status})));
      }
      if (q.includes("FROM public.accounting_entries") && q.includes("source='reversal'")) {
        return rows(state.entries.filter(e=>e.company_id===Number(args[0])&&e.source==="reversal"&&e.source_id===Number(args[1])).map(e=>({id:e.id,status:e.status})));
      }
      if (q.startsWith("INSERT INTO public.accounting_entries")) {
        const isReverse=q.includes("'reversal'");
        const companyId=Number(args[isReverse?7:8]);
        const id=state.nextId++;
        state.entries.push({id,company_id:companyId,source:isReverse?"reversal":"fleet_cash_payment",source_id:Number(args[isReverse?4:5]),status:"draft",debit:Number(args[isReverse?5:6]),credit:Number(args[isReverse?5:6])});
        return rows([{id}]);
      }
      if (q.startsWith("INSERT INTO public.accounting_entry_lines")) {state.lines.push(args);return rows([]);}
      if (q.startsWith("UPDATE public.accounting_entries")) {
        const entry=state.entries.find(e=>e.id===Number(args[0]));
        if (entry && entry.status==="draft") entry.status="posted";
        return rows([]);
      }
      throw Error("Unexpected isolated SQL: "+q.slice(0,120));
    },
    release: () => undefined,
  }))},
}));
import router from "../routes/fleet-finance-integration";

const originalToken=process.env.FLEET_FINANCE_SERVICE_TOKEN;
let server:Server, root:string;
beforeEach(async()=>{
  state.queries.length=0;state.entries.length=0;state.lines.length=0;
  state.nextId=900;state.source={id:55,company_id:3,status:"confirmed",amount:100,payment_date:"2026-11-17"};
  state.journalCompany=3;
  process.env.FLEET_FINANCE_SERVICE_TOKEN="dev-test-only-synthetic-token";
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{ (req as unknown as {log:{error:(...args:unknown[])=>void}}).log={error:()=>undefined}; next(); });
  app.use("/integrations/fleet",router);
  server=await new Promise<Server>(resolve=>{const srv=app.listen(0,"127.0.0.1",()=>resolve(srv));});
  const addr=server.address();if(!addr||typeof addr==="string")throw Error("Missing port");
  root="http://127.0.0.1:"+addr.port+"/integrations/fleet";
});
afterEach(async()=>{
  process.env.FLEET_FINANCE_SERVICE_TOKEN=originalToken;
  await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
});
async function call(path:string,body:Record<string,unknown>,token="dev-test-only-synthetic-token") {
  const res=await fetch(root+path,{method:"POST",headers:{"content-type":"application/json","idempotency-key":"isolated-qa-case-123","authorization":"Bearer "+token},body:JSON.stringify(body)});
  return {status:res.status,json:await res.json()};
}
const payment={companyId:3,paymentId:55,amount:100,driverName:"Fixture Driver",paymentDate:"2026-11-17"};
describe("existing Fleet BizPortal POST endpoints via real HTTP; disposable DB mock",()=>{
  it("fails closed without configured token and rejects incorrect bearer",async()=>{
    process.env.FLEET_FINANCE_SERVICE_TOKEN="";
    expect((await call("/cash-payments",payment)).status).toBe(503);
    process.env.FLEET_FINANCE_SERVICE_TOKEN="dev-test-only-synthetic-token";
    expect((await call("/cash-payments",payment,"wrong-token")).status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });
  it("posts once, preserves exact company, amounts and replays idempotently",async()=>{
    const first=await call("/cash-payments",payment);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({entryId:900,idempotent:false});
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({company_id:3,source:"fleet_cash_payment",source_id:55,status:"posted",debit:100,credit:100});
    expect(state.lines).toHaveLength(1);
    const again=await call("/cash-payments",payment);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({entryId:900,idempotent:true});
    expect(state.entries).toHaveLength(1);
  });
  it("denies cross-company, wrong amount and cancelled source before creating journals",async()=>{
    expect((await call("/cash-payments",{...payment,companyId:1})).status).toBeGreaterThanOrEqual(400);
    expect((await call("/cash-payments",{...payment,amount:101})).status).toBeGreaterThanOrEqual(400);
    state.source.status="cancelled";
    expect((await call("/cash-payments",payment)).status).toBeGreaterThanOrEqual(400);
    expect(state.entries).toHaveLength(0);
  });
  it("blocks inactive/wrong-company journal and unposted replay",async()=>{
    state.journalCompany=1;
    expect((await call("/cash-payments",payment)).status).toBeGreaterThanOrEqual(400);
    expect(state.entries).toHaveLength(0);
    state.journalCompany=3;
    state.entries.push({id:900,company_id:3,source:"fleet_cash_payment",source_id:55,status:"draft",debit:100,credit:100});
    expect((await call("/cash-payments",payment)).status).toBeGreaterThanOrEqual(400);
    expect(state.entries[0].status).toBe("draft");
  });
  it("reverses original posted payment once and rejects wrong company/amount",async()=>{
    expect((await call("/cash-payments",payment)).status).toBe(201);
    state.source.status="cancelled";
    const original={companyId:3,paymentId:55,originalEntryId:900,amount:100,driverName:"Fixture Driver"};
    expect((await call("/cash-payments/reverse",{...original,companyId:1})).status).toBeGreaterThanOrEqual(400);
    expect((await call("/cash-payments/reverse",{...original,amount:99})).status).toBeGreaterThanOrEqual(400);
    const reversal=await call("/cash-payments/reverse",original);
    expect(reversal.status).toBe(201);
    expect(state.entries[1]).toMatchObject({company_id:3,source:"reversal",source_id:900,status:"posted",debit:100,credit:100});
    const repeat=await call("/cash-payments/reverse",original);
    expect(repeat.status).toBe(200);
    expect(state.entries).toHaveLength(2);
  });
});
