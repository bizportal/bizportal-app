import { describe, expect, it, vi } from "vitest";
import {
  HRD_DOC_TYPES, MAX_DOCUMENT_BYTES, fieldsAllowedForDocument,
  validDocType, validMime, normalizeExtraction, validateReviewFields,
  ocrProviderFailureCode, documentMimeMatches
} from "./hrd-ocr-validation";

// Only invented synthetic data. Never use employee records, OCR files or tokens.
const nik="0000000000000000";
const kk="1111111111111111";
describe("legacy PROD OCR input validation parity using synthetic fixtures only",()=>{
  it("preserves eight document types and four MIME types",()=>{
    expect([...HRD_DOC_TYPES]).toEqual(["ktp","kk","foto","sim","npwp","ijazah","skck","kontrak"]);
    expect(MAX_DOCUMENT_BYTES).toBe(5*1024*1024);
    for(const type of HRD_DOC_TYPES)expect(validDocType(type)).toBe(true);
    expect(validDocType("KTP")).toBe(false);
    expect(validDocType("../ktp")).toBe(false);
    for(const m of ["image/jpeg","image/png","image/webp","application/pdf"])
      expect(validMime(m)).toBe(true);
    expect(validMime("text/html")).toBe(false);
    expect(validMime("image/svg+xml")).toBe(false);
  });
  it("normalizes OCR result without inventing values, and validates 16-digit identity fields",()=>{
    const result=normalizeExtraction({
      nik:" 123 ", nomor_kk:kk, nama_lengkap:"  CONTOH SINTETIS ",
      tanggal_lahir:"2026-3-1",alamat:34,nomor_dokumen:"X".repeat(400),
    },1.6,["warning",42,...Array.from({length:20},(_,i)=>"w"+i)]);
    expect(result.fields.nik).toBe(null);
    expect(result.fields.nomor_kk).toBe(kk);
    expect(result.fields.nama_lengkap).toBe("CONTOH SINTETIS");
    expect(result.fields.tanggal_lahir).toBe(null);
    expect(result.fields.alamat).toBe(null);
    expect(result.fields.nomor_dokumen?.length).toBe(320);
    expect(result.fields.jabatan).toBe(null);
    expect(result.confidence).toBe(1);
    expect(result.warnings).toHaveLength(12);
    expect(result.warnings.every(x=>typeof x==="string")).toBe(true);
    expect(normalizeExtraction(null,NaN,null).confidence).toBe(0);
    expect(normalizeExtraction({nik},-1,[]).fields.nik).toBe(nik);
  });
  it("does not accept unexpected fields or wrong document-specific identity fields",()=>{
    expect(fieldsAllowedForDocument("ktp",{nik,nama_lengkap:"SYNTHETIC"})).toEqual({nik,nama_lengkap:"SYNTHETIC"});
    expect(()=>fieldsAllowedForDocument("sim",{nik})).toThrow("FIELD_NOT_ALLOWED_FOR_DOCUMENT");
    expect(()=>fieldsAllowedForDocument("foto",{nama_lengkap:"Synthetic"})).toThrow("FIELD_NOT_ALLOWED_FOR_DOCUMENT");
    expect(fieldsAllowedForDocument("foto",{})).toEqual({});
    expect(()=>fieldsAllowedForDocument("npwp",{storage_path:"secret"})).toThrow("FIELD_NOT_ALLOWED_FOR_DOCUMENT");
  });
  it("validates reviewed OCR fields strictly without turning bad identity into accepted data",()=>{
    expect(validateReviewFields({nik,nomor_kk:kk,nama_lengkap:"  SINTETIS  "}))
      .toEqual({nik,nomor_kk:kk,nama_lengkap:"SINTETIS"});
    expect(()=>validateReviewFields(["bad"])).toThrow("INVALID_REVIEW_FIELDS");
    expect(()=>validateReviewFields({unknown:"x"})).toThrow("UNEXPECTED_REVIEW_FIELD");
    expect(()=>validateReviewFields({nama_lengkap:123})).toThrow("INVALID_REVIEW_VALUE");
    expect(()=>validateReviewFields({nik:"123"})).toThrow("NIK_MUST_BE_16_DIGITS");
    expect(()=>validateReviewFields({nomor_kk:"123"})).toThrow("KK_MUST_BE_16_DIGITS");
    expect(()=>validateReviewFields({nama_lengkap:"A".repeat(321)})).toThrow("REVIEW_VALUE_TOO_LONG");
    expect(validateReviewFields({nama_lengkap:"   "})).toEqual({nama_lengkap:null});
  });
  it("checks file magic headers on synthetic bytes and rejects mismatched MIME",()=>{
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(16)]);
    const jpeg=Buffer.from([0xff,0xd8,0xff,0x00]);
    const pdf=Buffer.from("%PDF-1.7 fake-content");
    const webp=Buffer.concat([Buffer.from("RIFF"),Buffer.alloc(4),Buffer.from("WEBP"),Buffer.alloc(4)]);
    expect(documentMimeMatches(png,"image/png")).toBe(true);
    expect(documentMimeMatches(jpeg,"image/jpeg")).toBe(true);
    expect(documentMimeMatches(pdf,"application/pdf")).toBe(true);
    expect(documentMimeMatches(webp,"image/webp")).toBe(true);
    expect(documentMimeMatches(png,"application/pdf")).toBe(false);
    expect(documentMimeMatches(Buffer.from("<html>"),"application/pdf")).toBe(false);
    expect(documentMimeMatches(Buffer.alloc(0),"image/png")).toBe(false);
    expect(documentMimeMatches(png,"image/svg+xml")).toBe(false);
  });
  it("maps known provider errors to allowlisted safe codes only",()=>{
    expect(ocrProviderFailureCode(429,"rate_limit_exceeded"))
      .toBe("HRD_OCR_PROVIDER_HTTP_429_RATE_LIMIT_EXCEEDED");
    expect(ocrProviderFailureCode(401,undefined,"invalid_api_key"))
      .toBe("HRD_OCR_PROVIDER_HTTP_401_INVALID_API_KEY");
    expect(ocrProviderFailureCode(503,"/secret?token=x"))
      .toBe("HRD_OCR_PROVIDER_HTTP_503");
    expect(ocrProviderFailureCode(200,"insufficient_quota"))
      .toBe("HRD_OCR_PROVIDER_FAILED");
  });
  it("never contacts storage, API, OCR provider or a database",()=>{
    const network=vi.fn(()=>{throw Error("NETWORK_MUST_NOT_BE_USED")});
    vi.stubGlobal("fetch",network);
    try {
      expect(normalizeExtraction({nik},"bad",[]).fields.nik).toBe(nik);
      expect(validMime("image/png")).toBe(true);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
