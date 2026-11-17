import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecret } from "../../../../lib/db/src/gcp-database-secret";

const bootstrapName = "gcp-secret-manager-bootstrap.json";
const envNames = [
  "APP_ENV", "NODE_ENV", "CREDENTIALS_DIRECTORY",
  "BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED",
  "GCP_SECRET_MANAGER_BOOTSTRAP_JSON",
] as const;
const original = Object.fromEntries(
  envNames.map(name => [name, process.env[name]]),
) as Record<string, string | undefined>;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const fakeBootstrap = JSON.stringify({
  project_id: "qa-synthetic-only",
  client_email: "test@fake.invalid",
  private_key: privateKey,
  token_uri: "https://oauth2.googleapis.com/token",
});
let directory = "";
let network: ReturnType<typeof vi.fn>;

function mountedFile(value = fakeBootstrap) {
  writeFileSync(join(directory, bootstrapName), value, { mode: 0o400 });
}
function enableDevMount() {
  process.env.APP_ENV = "development";
  process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED = "true";
  process.env.CREDENTIALS_DIRECTORY = directory;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bizportal-gcp-systemd-unit-"));
  for (const key of envNames) delete process.env[key];
  network = vi.fn(async (url: string | URL) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      return { ok: true, json: async () => ({ access_token: "fake-access-token" }) };
    }
    if (target.includes("secretmanager.googleapis.com/v1/")) {
      return {
        ok: true,
        json: async () => ({
          payload: { data: Buffer.from("synthetic-secret-fixture").toString("base64") },
        }),
      };
    }
    throw new Error("Unexpected network request from unit test");
  });
  vi.stubGlobal("fetch", network);
});

afterEach(() => {
  for (const key of envNames) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe("canonical GCP bootstrap using existing systemd DEV credential mount", () => {
  it("reads a private systemd credential with APP_ENV=development and bundled NODE_ENV=production", async () => {
    enableDevMount();
    process.env.NODE_ENV = "production"; // Real DEV release bundling mode.
    mountedFile();
    await expect(readSecret("qa-synthetic-only")).resolves.toBe("synthetic-secret-fixture");
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    expect(String(network.mock.calls[1][0])).toContain(
      "projects/qa-synthetic-only/secrets/qa-synthetic-only/versions/latest:access",
    );
  });

  it("never opens the systemd fallback on real APP_ENV=production", async () => {
    enableDevMount();
    mountedFile();
    process.env.APP_ENV = "production";
    await expect(readSecret("qa-only")).rejects.toThrow(
      "GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not configured",
    );
    expect(network).not.toHaveBeenCalled();
  });

  it("stays OFF in DEV without the explicit systemd bootstrap flag", async () => {
    enableDevMount();
    mountedFile();
    delete process.env.BIZPORTAL_DEV_SYSTEMD_GCP_BOOTSTRAP_ENABLED;
    await expect(readSecret("qa-only")).rejects.toThrow(
      "GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not configured",
    );
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects a relative or missing credential directory without leaking a path", async () => {
    enableDevMount();
    process.env.CREDENTIALS_DIRECTORY = "../relative-directory";
    await expect(readSecret("qa-only")).rejects.toThrow(
      "DEV_SYSTEMD_GCP_CREDENTIAL_UNAVAILABLE",
    );
    process.env.CREDENTIALS_DIRECTORY = directory;
    await expect(readSecret("qa-only")).rejects.toThrow(
      "DEV_SYSTEMD_GCP_CREDENTIAL_UNAVAILABLE",
    );
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversized mounted file", async () => {
    enableDevMount();
    mountedFile("");
    await expect(readSecret("qa-only")).rejects.toThrow(
      "DEV_SYSTEMD_GCP_CREDENTIAL_UNAVAILABLE",
    );
    mountedFile("x".repeat(16 * 1024 + 1));
    await expect(readSecret("qa-only")).rejects.toThrow(
      "DEV_SYSTEMD_GCP_CREDENTIAL_UNAVAILABLE",
    );
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps malformed JSON failures explicit but never exposes credential contents", async () => {
    enableDevMount();
    mountedFile("SYNTHETIC_INVALID_JSON");
    await expect(readSecret("qa-only")).rejects.toThrow(
      "GCP_SECRET_MANAGER_BOOTSTRAP_JSON is not valid JSON",
    );
    expect(network).not.toHaveBeenCalled();
  });

  it("preserves direct environment bootstrap precedence in either runtime", async () => {
    enableDevMount();
    process.env.APP_ENV = "production";
    process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON = fakeBootstrap;
    await expect(readSecret("qa-synthetic-only")).resolves.toBe("synthetic-secret-fixture");
    expect(network).toHaveBeenCalledTimes(2);
  });
});
