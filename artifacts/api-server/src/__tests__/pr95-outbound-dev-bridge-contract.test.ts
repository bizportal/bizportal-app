import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import type { Request } from "express";
import type { OutboundReuseQueryClient } from "../lib/outboundReuseFinalityReader";

vi.mock("../lib/outboundSourceReuseDevAuth",()=>({
  resolveOutboundSourceReuseDevPrincipal:vi.fn(),
}));
vi.mock("../lib/outboundSourceReuseCandidate",()=>({
  finalizeOutboundSourceReuseCandidate:vi.fn(),
}));
import { resolveOutboundSourceReuseDevPrincipal } from "../lib/outboundSourceReuseDevAuth";
import { finalizeOutboundSourceReuseCandidate } from "../lib/outboundSourceReuseCandidate";
import { runOutboundReuseSignedDevCandidate } from "../lib/outboundSourceReuseDevBridge";

const auth=vi.mocked(resolveOutboundSourceReuseDevPrincipal);
const writer=vi.mocked(finalizeOutboundSourceReuseCandidate);
const req={} as Request;
const tx={} as OutboundReuseQueryClient;
const input={companyId:1,mutationId:90001,invoiceId:7};
const previous=process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV;

describe("PR95 unregistered DEV-only authenticated writer bridge (mock-only)",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV="true";
    auth.mockResolvedValue({
      id:"signed-user",email:"admin@example.invalid",companyId:1,role:"super_admin",
    });
    writer.mockResolvedValue({
      mutationId:90001,invoiceId:7,sourceEntryId:314,paymentMatchingGroupId:4,
    });
  });
  afterEach(()=>{
    if(previous===undefined)delete process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV;
    else process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV=previous;
  });
  it("does not read identity or write when feature remains disabled",async()=>{
    delete process.env.PR95_OUTBOUND_SOURCE_REUSE_ENABLED_DEV;
    await expect(runOutboundReuseSignedDevCandidate(req,tx,input))
      .rejects.toThrow("PR95_OUTBOUND_DEV_WRITER_DISABLED");
    expect(auth).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });
  it("authorizes the signed principal before calling existing candidate with canonical company",async()=>{
    const result=await runOutboundReuseSignedDevCandidate(req,tx,input);
    expect(result.sourceEntryId).toBe(314);
    expect(auth).toHaveBeenCalledWith(req,1);
    expect(writer).toHaveBeenCalledWith(tx,{
      companyId:1,mutationId:90001,invoiceId:7,
      verifiedActorEmail:"admin@example.invalid",
    });
  });
  it("never writes when DB session verification rejects or company mismatches",async()=>{
    auth.mockRejectedValueOnce(Error("PR95_OUTBOUND_SIGNED_SESSION_REQUIRED"));
    await expect(runOutboundReuseSignedDevCandidate(req,tx,input))
      .rejects.toThrow("PR95_OUTBOUND_SIGNED_SESSION_REQUIRED");
    auth.mockResolvedValueOnce({
      id:"signed-user",email:"admin@example.invalid",companyId:2,role:"super_admin",
    });
    await expect(runOutboundReuseSignedDevCandidate(req,tx,input))
      .rejects.toThrow("PR95_OUTBOUND_COMPANY_SCOPE_FORBIDDEN");
    expect(writer).not.toHaveBeenCalled();
  });
});
