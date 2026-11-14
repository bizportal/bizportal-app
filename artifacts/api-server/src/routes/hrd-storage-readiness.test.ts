import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hrdStorageMetadataPreflightEnabled, probeHrdPrivateStorageMetadata } from "./hrd-storage-readiness";

const bucket = {
  id:"bizportal-hrd-documents-prod",
  public:false,
  file_size_limit:5*1024*1024,
  allowed_mime_types:["image/jpeg","image/png","image/webp","application/pdf"],
};
const response=(data:unknown,status=200)=>
  new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});

describe("pinned private HRD storage metadata preflight",()=>{
  beforeEach(()=>{
    vi.stubEnv("APP_ENV","production");
    vi.stubEnv("HRD_CANONICAL_READONLY_ENABLED","true");
    vi.stubEnv("HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED","true");
    vi.stubEnv("HRD_PROD_SUPABASE_URL","https://nzdweipzckfszczzqtuw.supabase.co");
    vi.stubEnv("HRD_PROD_STORAGE_SERVICE_KEY","example-fake-credential");
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
  it("never contacts external storage while disabled or outside PROD",async()=>{
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    vi.stubEnv("HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED","");
    expect(hrdStorageMetadataPreflightEnabled()).toBe(false);
    expect(await probeHrdPrivateStorageMetadata()).toBe(false);
    vi.stubEnv("HRD_CANONICAL_STORAGE_PREFLIGHT_ENABLED","true");
    vi.stubEnv("HRD_CANONICAL_READONLY_ENABLED","");
    expect(await probeHrdPrivateStorageMetadata()).toBe(false);
    vi.stubEnv("HRD_CANONICAL_READONLY_ENABLED","true");
    vi.stubEnv("APP_ENV","development");
    expect(await probeHrdPrivateStorageMetadata()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed for non-pinned URL or absent service credential",async()=>{
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    vi.stubEnv("HRD_PROD_SUPABASE_URL","https://untrusted.example");
    expect(await probeHrdPrivateStorageMetadata()).toBe(false);
    vi.stubEnv("HRD_PROD_SUPABASE_URL","https://nzdweipzckfszczzqtuw.supabase.co");
    vi.stubEnv("HRD_PROD_STORAGE_SERVICE_KEY","");
    expect(await probeHrdPrivateStorageMetadata()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks only bucket metadata with GET and no listing, signing, upload or delete",async()=>{
    const fetcher=vi.fn().mockResolvedValue(response(bucket));
    vi.stubGlobal("fetch",fetcher);
    expect(await probeHrdPrivateStorageMetadata()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url,request]=fetcher.mock.calls[0] as [string,RequestInit];
    expect(url).toBe("https://nzdweipzckfszczzqtuw.supabase.co/storage/v1/bucket/bizportal-hrd-documents-prod");
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    expect(request.body).toBeUndefined();
    expect(JSON.stringify({ ready:true })).not.toContain("example-fake-credential");
  });
  it("rejects public, oversized, wrong-bucket, unrestricted or duplicate MIME metadata",async()=>{
    const samples=[
      {...bucket,public:true}, {...bucket,file_size_limit:6*1024*1024},
      {...bucket,id:"other-bucket"}, {...bucket,allowed_mime_types:null},
      {...bucket,allowed_mime_types:["image/jpeg","image/png","image/webp","*"]},
      {...bucket,allowed_mime_types:["image/jpeg","image/png","image/png","application/pdf"]},
    ];
    const fetcher=vi.fn();
    vi.stubGlobal("fetch",fetcher);
    for(const sample of samples){
      fetcher.mockResolvedValueOnce(response(sample));
      expect(await probeHrdPrivateStorageMetadata()).toBe(false);
    }
  });
  it("fails closed for non-success HTTP, malformed JSON and network errors",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(response({error:"unavailable"},503))
      .mockResolvedValueOnce(new Response("invalid",{status:200}))
      .mockRejectedValueOnce(Error("secret-not-for-client"));
    vi.stubGlobal("fetch",fetcher);
    expect(await probeHrdPrivateStorageMetadata()).toBe(false);
    expect(await probeHrdPrivateStorageMetadata()).toBe(false);
    expect(await probeHrdPrivateStorageMetadata()).toBe(false);
  });
});
