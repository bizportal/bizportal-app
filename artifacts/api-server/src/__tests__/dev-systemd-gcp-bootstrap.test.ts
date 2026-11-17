import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecret } from "@workspace/db/gcp-database-secret";

const VARIABLES = [
  "APP_ENV", "GCP_SECRET_MANAGER_BOOTSTRAP_JSON",
  "CREDENTIALS_DIRECTORY", "BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED",
] as const;
const original = Object.fromEntries(VARIABLES.map(k => [k, process.env[k]]));
let directory: string;
const testCredentialFile = () => join(directory, "gcp-secret-manager-bootstrap.json");
const fakeCredentials = () => {
  // Ephemeral, local-only synthetic key. No real GCP credentials or network.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    project_id: "synthetic-gcp-unit-tests",
    client_email: "not-real@example.invalid",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
    token_uri: "https://oauth2.googleapis.com/token",
  });
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pr81-systemd-credential-test-"));
  for (const k of VARIABLES) delete process.env[k];
  process.env.APP_ENV = "development";
  process.env.CREDENTIALS_DIRECTORY = directory;
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
  for (const k of VARIABLES) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("PR #81: opt-in DEV systemd Secret Manager bootstrap", () => {
  it("is disabled by default, including with CREDENTIALS_DIRECTORY present", async () => {
    writeFileSync(testCredentialFile(), fakeCredentials());
    await expect(readSecret("synthetic-secret")).rejects.toThrow(
      "GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not configured",
    );
  });
  it("must never activate the systemd fallback in PROD", async () => {
    process.env.APP_ENV = "production";
    process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED = "true";
    writeFileSync(testCredentialFile(), fakeCredentials());
    await expect(readSecret("synthetic-secret")).rejects.toThrow("not configured");
  });
  it("fails closed when the DEV systemd file is absent or oversized", async () => {
    process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED = "true";
    await expect(readSecret("synthetic-secret")).rejects.toThrow(
      "DEV_SYSTEMD_GCP_CREDENTIAL_UNAVAILABLE",
    );
    writeFileSync(testCredentialFile(), "X".repeat(16 * 1024 + 1));
    await expect(readSecret("synthetic-secret")).rejects.toThrow(
      "DEV_SYSTEMD_GCP_CREDENTIAL_UNAVAILABLE",
    );
  });
  it("does not expose malformed credential bytes in errors", async () => {
    process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED = "true";
    writeFileSync(testCredentialFile(), "never-expose-this-synthetic-value");
    await expect(readSecret("synthetic-secret")).rejects.toThrow(
      "GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not valid JSON",
    );
  });
  it("keeps explicit environment precedence rather than using another key", async () => {
    process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED = "true";
    writeFileSync(testCredentialFile(), fakeCredentials());
    process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON = "bad-environment-json";
    await expect(readSecret("synthetic-secret")).rejects.toThrow(
      "GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not valid JSON",
    );
  });
  it("reads one test-only systemd credential and uses mocked Google endpoints", async () => {
    process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED = "true";
    writeFileSync(testCredentialFile(), fakeCredentials(), { mode: 0o600 });
    const mockFetch = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "fake-test-token" });
      }
      if (value.includes("/secrets/synthetic-secret/versions/latest:access")) {
        return Response.json({
          payload: { data: Buffer.from("fake-DEV-secret-value").toString("base64") },
        });
      }
      throw new Error("Unexpected network call in synthetic test");
    });
    vi.stubGlobal("fetch", mockFetch);
    await expect(readSecret("synthetic-secret")).resolves.toBe("fake-DEV-secret-value");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
