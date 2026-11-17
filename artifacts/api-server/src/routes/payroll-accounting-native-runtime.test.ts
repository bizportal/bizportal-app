import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const state = vi.hoisted(() => ({ binds: [] as unknown[], fail: false }));
vi.mock("./payroll-accounting-http", () => ({
  bindDevPayrollAtomicHttpRuntime: async (binding: unknown) => {
    state.binds.push(binding);
    if (state.fail) throw Error("PAYROLL_RUNTIME_PREFLIGHT_REJECTED");
  },
}));
import { loadDevPayrollNativeArtifact, bindDevPayrollNativeArtifactRuntime } from "./payroll-accounting-native-runtime";
let directory: string;
const source = `export const nativeArtifactContract='payroll-native-accrual-artifact-v1';
export const PayrollJournalService=Object.freeze({transactionalAccrualVersion:'payroll-accrual-atomic-v1',
async postAccrualJournal(){throw Error('SYNTHETIC_TEST_NOT_A_FINANCIAL_WRITER');}});`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function file(value = source) {
  const path = join(directory, "native-accrual.mjs");await writeFile(path, value, { mode: 0o600 });return path;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "payroll-native-loader-"));state.binds.length=0;state.fail=false;
  vi.stubEnv("APP_ENV","development");vi.stubEnv("PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED","true");
  vi.stubEnv("PAYROLL_DEV_ATOMIC_POSTING_ENABLED","true");
});
afterEach(async () => {vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});

describe("DEV native accrual artifact loader (synthetic byte fixture)", () => {
  it("loads only verified bytes and exposes only the frozen accrual capability", async () => {
    const writer = await loadDevPayrollNativeArtifact(await file(), hash(source));
    expect(Object.keys(writer).sort()).toEqual(["postAccrualJournal","transactionalAccrualVersion"]);
    expect(Object.isFrozen(writer)).toBe(true);expect(state.binds).toHaveLength(0);
  });
  it("passes the actual verified writer and same pool/origin to the existing async binder", async () => {
    const path=await file(),pool={connect:vi.fn()};
    await bindDevPayrollNativeArtifactRuntime({artifactPath:path,expectedSha256:hash(source),pool,allowedOrigin:"https://dev.example.test"});
    expect(state.binds).toHaveLength(1);
    expect(state.binds[0]).toMatchObject({pool,allowedOrigin:"https://dev.example.test",
      writer:{transactionalAccrualVersion:"payroll-accrual-atomic-v1"}});
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it.each(["production", ""])("does not read an artifact in APP_ENV=%s", async environment => {
    vi.stubEnv("APP_ENV",environment);
    await expect(loadDevPayrollNativeArtifact("/missing/native.mjs",hash(source))).rejects.toThrow("RUNTIME_DISABLED");
  });
  it.each(["PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED","PAYROLL_DEV_ATOMIC_POSTING_ENABLED"])("stays off when %s is absent",async key=>{
    vi.stubEnv(key,"");await expect(loadDevPayrollNativeArtifact(await file(),hash(source))).rejects.toThrow("RUNTIME_DISABLED");
  });
  it("rejects tampered bytes before evaluating them", async () => {
    const marker="globalThis.__payrollArtifactMustNotRun=true;\n";
    await expect(loadDevPayrollNativeArtifact(await file(marker+source),hash(source))).rejects.toThrow("ARTIFACT_REJECTED");
    expect((globalThis as Record<string,unknown>).__payrollArtifactMustNotRun).toBeUndefined();
  });
  it.each(["","not-a-hash","A".repeat(64)])("rejects invalid expected fingerprint %s",async digest=>{
    await expect(loadDevPayrollNativeArtifact(await file(),digest)).rejects.toThrow("ARTIFACT_REJECTED");
  });
  it("rejects relative paths and file symlinks",async()=>{
    const path=await file(),link=join(directory,"link.mjs");await symlink(path,link);
    await expect(loadDevPayrollNativeArtifact("relative.mjs",hash(source))).rejects.toThrow("ARTIFACT_REJECTED");
    await expect(loadDevPayrollNativeArtifact(link,hash(source))).rejects.toThrow("ARTIFACT_REJECTED");
  });
  it.each(["", "export const bad=true;", source+"\nexport const postPaymentJournal=()=>{};",
    source.replace("artifact-v1","artifact-v9"),source.replace("atomic-v1","atomic-v9")])("rejects invalid or expanded export contract",async value=>{
    await expect(loadDevPayrollNativeArtifact(await file(value),hash(value))).rejects.toThrow("ARTIFACT_REJECTED");
  });
  it("rejects files above the configured size bound",async()=>{
    await expect(loadDevPayrollNativeArtifact(await file(" ".repeat(4*1024*1024+1)),hash(source))).rejects.toThrow("ARTIFACT_REJECTED");
  });
  it("redacts missing file and module execution errors",async()=>{
    await expect(loadDevPayrollNativeArtifact(join(directory,"missing.mjs"),hash(source))).rejects.toThrow(/^PAYROLL_NATIVE_ARTIFACT_REJECTED$/);
    const broken="throw Error('secret-not-to-reflect');\n"+source;
    await expect(loadDevPayrollNativeArtifact(await file(broken),hash(broken))).rejects.toThrow(/^PAYROLL_NATIVE_ARTIFACT_REJECTED$/);
  });
  it("propagates failure of the existing permission preflight without retrying with another pool",async()=>{
    const path=await file();state.fail=true;
    await expect(bindDevPayrollNativeArtifactRuntime({artifactPath:path,expectedSha256:hash(source),pool:{connect:vi.fn()},
      allowedOrigin:"https://dev.example.test"})).rejects.toThrow("PREFLIGHT_REJECTED");
    expect(state.binds).toHaveLength(1);
  });
});
