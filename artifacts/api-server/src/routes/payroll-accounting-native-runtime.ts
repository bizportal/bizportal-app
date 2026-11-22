import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { bindDevPayrollAtomicHttpRuntime } from "./payroll-accounting-http";
import type { TransactionBoundPayrollWriter } from "./payroll-accounting-transaction";

const MAX_BYTES = 4 * 1024 * 1024;
const enabled = () => process.env.APP_ENV === "development" &&
  process.env.PAYROLL_DEV_ATOMIC_ROUTE_MOUNT_ENABLED === "true" &&
  process.env.PAYROLL_DEV_ATOMIC_POSTING_ENABLED === "true";

/** Trusted server composition ONLY. Expected hash comes from independently
 * approved release configuration, never request JSON or a self-supplied manifest.
 * Import the exact verified bytes, not a path that could change after checking.
 * This authenticates artifact integrity, not permissions/actor/approval authority.
 * Packaging only permits node:crypto as an external import; no global pool/secret.
 */
export async function loadDevPayrollNativeArtifact(
  artifactPath: string, expectedSha256: string,
): Promise<TransactionBoundPayrollWriter> {
  if (!enabled()) throw Error("PAYROLL_NATIVE_RUNTIME_DISABLED");
  if (typeof artifactPath !== "string" || !isAbsolute(artifactPath) || !artifactPath.endsWith(".mjs") ||
      typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256))
    throw Error("PAYROLL_NATIVE_ARTIFACT_REJECTED");
  try {
    const file = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) throw Error("FILE_REJECTED");
      // Bounded read handles a file growing/truncating while it is open.
      const buffer = Buffer.alloc(stat.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const next = await file.read(buffer, used, buffer.length - used, used);
        if (next.bytesRead === 0) break;
        used += next.bytesRead;
      }
      if (used !== stat.size) throw Error("FILE_CHANGED");
      bytes = buffer.subarray(0, used);
    } finally { await file.close(); }
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw Error("HASH_REJECTED");
    if (!enabled()) throw Error("GATE_CHANGED");
    const loaded = await import(/* @vite-ignore */ "data:text/javascript;base64," + bytes.toString("base64"));
    if (!enabled() || loaded.nativeArtifactContract !== "payroll-native-accrual-artifact-v1" ||
        JSON.stringify(Object.keys(loaded).sort()) !== JSON.stringify(["PayrollJournalService", "nativeArtifactContract"]) ||
        loaded.PayrollJournalService?.transactionalAccrualVersion !== "payroll-accrual-atomic-v1" ||
        typeof loaded.PayrollJournalService.postAccrualJournal !== "function" ||
        JSON.stringify(Object.keys(loaded.PayrollJournalService).sort()) !==
          JSON.stringify(["postAccrualJournal", "transactionalAccrualVersion"])) throw Error("EXPORT_REJECTED");
    return Object.freeze(loaded.PayrollJournalService);
  } catch {
    // Path, SQL, raw import errors and source bytes never go to an HTTP response.
    throw Error("PAYROLL_NATIVE_ARTIFACT_REJECTED");
  }
}

/** Reuses the existing async binder and its direct-role READ ONLY preflight.
 * The restricted pool is supplied by trusted startup. This function never
 * creates a shared pool, obtains a credential, authenticates a user or posts.
 */
export async function bindDevPayrollNativeArtifactRuntime(options: {
  artifactPath: string;
  expectedSha256: string;
  pool: Pick<Pool, "connect">;
  allowedOrigin: string;
}): Promise<void> {
  const writer = await loadDevPayrollNativeArtifact(options.artifactPath, options.expectedSha256);
  await bindDevPayrollAtomicHttpRuntime({ pool: options.pool, writer, allowedOrigin: options.allowedOrigin });
}
