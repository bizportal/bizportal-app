import { beforeEach,describe,expect,it,vi } from "vitest";

const mock=vi.hoisted(()=>({
  rows:new Map<string,unknown[]>(),
  inserts:[] as Array<{table:string,value:Record<string,unknown>}>,
  updates:[] as Array<{table:string,value:Record<string,unknown>}>,
  locks:[] as string[],
}));
vi.mock("@workspace/db",()=>{
  const keys=[
    "mktApPreparationsTable","mktAccountingHandoffsTable","paymentRequestsTable",
    "mktPoGoodsReceiptsTable","mktPoShipmentsTable",
    "mktPurchaseOrdersTable","vendorInvoicesTable",
  ];
  const tables=Object.fromEntries(keys.map(k=>[k,{key:k}]));
  const tx={
    select:()=>({
      from:(table:{key:string})=>({
        where:()=>({
          for:(mode:string)=>({limit:async()=>{mock.locks.push(mode);return mock.rows.get(table.key)??[]}}),
          limit:async()=>mock.rows.get(table.key)??[],
        }),
      }),
    }),
    insert:(table:{key:string})=>({
      values:(value:Record<string,unknown>)=>({
        returning:async()=>{
          mock.inserts.push({table:table.key,value});
          const id=table.key==="paymentRequestsTable"?41:9;
          const inserted={...value,id};
          if(table.key==="mktAccountingHandoffsTable") mock.rows.set(table.key,[inserted]);
          return [inserted];
        },
      }),
    }),
    update:(table:{key:string})=>({
      set:(value:Record<string,unknown>)=>({
        where:async()=>{mock.updates.push({table:table.key,value});return [];},
      }),
    }),
  };
  return {db:{transaction:vi.fn(async(fn:(tx:unknown)=>unknown)=>fn(tx))},...tables};
});
vi.mock("drizzle-orm",()=>({and:vi.fn(),eq:vi.fn(),asc:vi.fn()}));
vi.mock("../activityLog.js",()=>({logActivity:vi.fn()}));
vi.mock("./marketplaceNotificationQueueService.js",()=>({enqueueNotification:vi.fn()}));
import {createMarketplaceAccountingHandoff} from "./mktApPreparationService.js";
const ap={
  id:88,status:"waiting_payment",companyId:1,supplierId:5,
  mktPurchaseOrderId:12,mktGoodsReceiptId:9,vendorInvoiceId:77,
  supplierName:"DEV Vendor",grandTotalSnapshot:"100.00",currencySnapshot:"IDR",
  financeReviewedBy:"dev-super-admin",financeReviewedAt:new Date("2026-11-14"),
};
beforeEach(()=>{
  mock.rows.clear();mock.inserts.length=0;mock.updates.length=0;mock.locks.length=0;
  mock.rows.set("mktApPreparationsTable",[ap]);
  mock.rows.set("mktAccountingHandoffsTable",[]);
  mock.rows.set("vendorInvoicesTable",[{
    id:77,status:"ready_for_ap",threeWayMatchStatus:"passed",
    companyId:1,supplierId:5,mktPurchaseOrderId:12,mktGoodsReceiptId:9,
  }]);
  mock.rows.set("mktPurchaseOrdersTable",[{id:12,companyId:1,vendorId:5}]);
  mock.rows.set("mktPoGoodsReceiptsTable",[{id:9,shipmentId:3,inspectionStatus:"passed"}]);
  mock.rows.set("mktPoShipmentsTable",[{id:3,poId:12,shipmentStatus:"delivered"}]);
});
describe("canonical AP to Accounting draft-only handoff",()=>{
  it("refuses any AP not yet waiting_payment before writes",async()=>{
    mock.rows.set("mktApPreparationsTable",[{...ap,status:"finance_review"}]);
    expect(await createMarketplaceAccountingHandoff(88,{}))
      .toMatchObject({ok:false,code:"INVALID_STATUS"});
    expect(mock.inserts).toHaveLength(0);
  });
  it("refuses supplier/company mismatch before creating payment request",async()=>{
    mock.rows.set("mktPurchaseOrdersTable",[{id:12,companyId:2,vendorId:5}]);
    expect(await createMarketplaceAccountingHandoff(88,{}))
      .toMatchObject({ok:false,code:"MISSING_REFERENCE"});
    expect(mock.inserts).toHaveLength(0);
  });
  it("creates one draft request + one handoff; replay returns identical IDs",async()=>{
    const first=await createMarketplaceAccountingHandoff(88,{actorId:"dev-super-admin"});
    expect(first).toMatchObject({ok:true,alreadyExists:false,paymentRequestId:41,handoffId:9});
    expect(mock.locks).toContain("update");
    expect(mock.inserts.map(x=>x.table)).toEqual(["paymentRequestsTable","mktAccountingHandoffsTable"]);
    const payment=mock.inserts[0].value;
    expect(payment).toMatchObject({
      status:"draft",paidAmount:"0.00",mktApPreparationId:88,
      idempotencyKey:"mkt-ap:88",mktLifecycleStatus:"waiting_payment",
    });
    expect(payment).not.toHaveProperty("journalEntryId");
    expect(mock.inserts[1].value).toMatchObject({
      status:"accepted",accountingStatus:"draft_not_posted",
      apPreparationId:88,paymentRequestId:41,
    });
    const again=await createMarketplaceAccountingHandoff(88,{actorId:"dev-super-admin"});
    expect(again).toMatchObject({ok:true,alreadyExists:true,paymentRequestId:41,handoffId:9});
    expect(mock.inserts).toHaveLength(2);
    expect(mock.updates).toHaveLength(1);
  });
});
