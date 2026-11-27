import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareFutureCashSource } from "../lib/future-cash-source-identity";
import { auditPendingFutureCashBytes, readPendingFutureCashVerifiedBytes, type PendingCashIntegritySqlReader } from "../lib/future-cash-pending-integrity";
import type { PrivateCashFileReader } from "../lib/future-cash-private-receipt";

const id = "25088529-6fa1-4ddb-80bf-390c157e64d4";
const bytes = Buffer.from("%PDF-1.7\nfixture-only; never a real receipt");
const digest = createHash("sha256").update(bytes).digest("hex");
const fingerprint = prepareFutureCashSource({
  transactionId:id, companyId:1, accountId:18, cashCoaId:75839,
  sourceDocumentSha256:digest, direction:"IN", date:"2026-11-27", amount:"10000.00",
}).sourceFingerprint;
const row = {
  transaction_id:id, company_id:1, account_id:18, cash_coa_id:75839,
  object_bucket:"private-uploads",
  object_path:"/objects/uploads/360deca8-6103-4ab6-9c44-c9c109b51b58.pdf",
  document_sha256:digest, source_fingerprint:fingerprint,
  direction:"IN", transaction_date:"2026-11-27", amount_cents:"1000000",
  byte_length:bytes.length, event_count:"0",
};
type Row = typeof row & {latest_event?:string|null};
const reader = (records:Row[]):PendingCashIntegritySqlReader => ({
  query:async(sql,params)=>{
    expect(sql).toContain("public.sc_future_cash_documents");
    expect(sql).toContain("public.sc_future_cash_document_events");
    expect(params).toEqual([id]);
    return {rows:records};
  },
});
const storage = (actual:Buffer, size=bytes.length):PrivateCashFileReader => ({
  getObjectEntitySize:async()=>size,
  getObjectEntityFile:async()=>({bucket:"private-uploads",path:row.object_path.slice(9)}),
  downloadObject:async()=>({arrayBuffer:async()=>Uint8Array.from(actual).buffer as ArrayBuffer}),
});

describe("Account18 server-only pending evidence integrity audit (no posting)",()=>{
  it("re-downloads private bytes, validates source fingerprint and SHA-256",async()=>{
    expect(await auditPendingFutureCashBytes(id,reader([row]),storage(bytes))).toBe("MATCH");
  });
  it("returns only genuinely validated private bytes to the authenticated download route",async()=>{
    const valid=await readPendingFutureCashVerifiedBytes(id,reader([row]),storage(bytes));
    expect(valid?.extension).toBe("pdf");
    expect(valid?.bytes.equals(bytes)).toBe(true);
    const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
    expect(await readPendingFutureCashVerifiedBytes(id,reader([row]),storage(changed))).toBeNull();
    expect(await readPendingFutureCashVerifiedBytes(id,reader([{...row,event_count:"1"}]),storage(bytes))).toBeNull();
  });
  it("rejects tampered storage bytes and size mismatch",async()=>{
    const tampered=Buffer.from(bytes);tampered[tampered.length-1]^=1;
    expect(await auditPendingFutureCashBytes(id,reader([row]),storage(tampered))).toBe("UNAVAILABLE");
    expect(await auditPendingFutureCashBytes(id,reader([row]),storage(bytes,bytes.length+1))).toBe("UNAVAILABLE");
  });
  it("rejects modified fingerprint, untrusted scope, and verified/revoked events",async()=>{
    expect(await auditPendingFutureCashBytes(id,reader([{...row,source_fingerprint:"0".repeat(64)}]),storage(bytes))).toBe("UNAVAILABLE");
    expect(await auditPendingFutureCashBytes(id,reader([{...row,company_id:2}]),storage(bytes))).toBe("UNAVAILABLE");
    expect(await auditPendingFutureCashBytes(id,reader([{...row,event_count:"1"}]),storage(bytes))).toBe("UNAVAILABLE");
  });
  it("fails closed for invalid UUID, missing records and database errors",async()=>{
    expect(await auditPendingFutureCashBytes("../other",reader([row]),storage(bytes))).toBe("UNAVAILABLE");
    expect(await auditPendingFutureCashBytes(id,reader([]),storage(bytes))).toBe("UNAVAILABLE");
    const broken:PendingCashIntegritySqlReader={query:async()=>{throw Error("DB down");}};
    expect(await auditPendingFutureCashBytes(id,broken,storage(bytes))).toBe("UNAVAILABLE");
  });
  it("allows validated VERIFIED download only when explicitly enabled and denies revoked or tampered proof",async()=>{
    const verified={...row,event_count:"1",latest_event:"VERIFIED"};
    expect((await readPendingFutureCashVerifiedBytes(id,reader([verified]),storage(bytes),true))?.bytes.equals(bytes)).toBe(true);
    expect(await auditPendingFutureCashBytes(id,reader([verified]),storage(bytes))).toBe("UNAVAILABLE");
    expect(await readPendingFutureCashVerifiedBytes(id,reader([{...verified,event_count:"2",latest_event:"REVOKED"}]),storage(bytes),true)).toBeNull();
    expect(await readPendingFutureCashVerifiedBytes(id,reader([{...verified,latest_event:"REVOKED"}]),storage(bytes),true)).toBeNull();
    const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
    expect(await readPendingFutureCashVerifiedBytes(id,reader([verified]),storage(changed),true)).toBeNull();
  });

});
