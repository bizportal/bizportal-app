import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDevApprovalPool,
  devApprovalDedicatedEnabled,
  prepareDevApprovalCredential,
} from "./payroll-dev-approval-db";

const project = "xssrfshdrtdfupgqwfdw";
const managed = (host = "db." + project + ".supabase.co",
  login = "bizportal_payroll_approver_dev", query = "sslmode=verify-full") =>
  "postgresql://" + login + ":example-disposable-not-real@" + host + ":5432/postgres?" + query;

describe("DEV Payroll approver GCP Secret Manager source", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "true");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED", "true");
    vi.stubEnv("PAYROLL_APPROVAL_DATABASE_URL_DEV", "");
    vi.stubEnv("PAYROLL_APPROVAL_GCP_SECRET_NAME_DEV", "bizportal-payroll-approver-dev");
  });
  afterEach(async () => {
    await closeDevApprovalPool();
    vi.unstubAllEnvs();
  });

  it("reuses dedicated managed DEV secret with no shared database fallback", async () => {
    const reader = vi.fn(async () => managed());
    expect(devApprovalDedicatedEnabled()).toBe(false);
    expect(await prepareDevApprovalCredential(reader)).toBe(true);
    expect(reader).toHaveBeenCalledExactlyOnceWith("bizportal-payroll-approver-dev");
    expect(devApprovalDedicatedEnabled()).toBe(true);
  });

  it("accepts correctly project-suffixed pooler login and verified TLS mode", async () => {
    const login = "bizportal_payroll_approver_dev." + project;
    const reader = vi.fn(async () => managed("aws-0-ap-southeast-2.pooler.supabase.com", login));
    expect(await prepareDevApprovalCredential(reader)).toBe(true);
    expect(devApprovalDedicatedEnabled()).toBe(true);
  });

  it("refuses secret and direct-env credential ambiguity without opening any pool", async () => {
    vi.stubEnv("PAYROLL_APPROVAL_DATABASE_URL_DEV", managed());
    const reader = vi.fn(async () => managed());
    await expect(prepareDevApprovalCredential(reader)).rejects.toThrow(
      "PAYROLL_DEV_APPROVAL_CREDENTIAL_SOURCE_AMBIGUOUS");
    expect(reader).not.toHaveBeenCalled();
    expect(devApprovalDedicatedEnabled()).toBe(false);
  });

  it("never reads any credential outside development or when write gates are off", async () => {
    const reader = vi.fn(async () => managed());
    for (const env of ["production", ""]) {
      vi.stubEnv("APP_ENV", env);
      expect(await prepareDevApprovalCredential(reader)).toBe(false);
      expect(devApprovalDedicatedEnabled()).toBe(false);
    }
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED", "");
    expect(await prepareDevApprovalCredential(reader)).toBe(false);
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED", "true");
    vi.stubEnv("PAYROLL_DEV_SUPER_ADMIN_ROUTE_MOUNT_ENABLED", "");
    expect(await prepareDevApprovalCredential(reader)).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects alternate secret names before requesting GCP", async () => {
    vi.stubEnv("PAYROLL_APPROVAL_GCP_SECRET_NAME_DEV", "cst-super-app-production");
    const reader = vi.fn(async () => managed());
    await expect(prepareDevApprovalCredential(reader)).rejects.toThrow(
      "PAYROLL_DEV_APPROVAL_SECRET_NAME_INVALID");
    expect(reader).not.toHaveBeenCalled();
    expect(devApprovalDedicatedEnabled()).toBe(false);
  });

  it.each([
    ["PROD host", managed("db.nzdweipzckfszczzqtuw.supabase.co")],
    ["legacy Payroll identity", managed(undefined, "bizportal_payroll_dev")],
    ["unscoped pooler", managed("aws-0-ap-southeast-2.pooler.supabase.com")],
    ["foreign host", managed("db.evil.example")],
    ["insecure TLS", managed(undefined, undefined, "sslmode=require")],
    ["missing TLS", managed(undefined, undefined, "")],
    ["duplicate TLS", managed(undefined, undefined, "sslmode=verify-full&sslmode=disable")],
    ["query host override", managed(undefined, undefined, "sslmode=verify-full&host=evil.example")],
    ["query username override", managed(undefined, undefined, "sslmode=verify-full&user=postgres")],
    ["wrong database", managed().replace("/postgres?", "/other?")],
    ["missing password", managed().replace(":example-disposable-not-real@", "@")],
  ])("rejects %s before exposing the pool", async (_label, url) => {
    await expect(prepareDevApprovalCredential(async () => url)).rejects.toThrow(
      "PAYROLL_DEV_APPROVAL_MANAGED_SECRET_INVALID");
    expect(devApprovalDedicatedEnabled()).toBe(false);
  });

  it("refuses to silently rotate an active cached GCP URL", async () => {
    await prepareDevApprovalCredential(async () => managed());
    await expect(prepareDevApprovalCredential(async () =>
      managed().replace("example-disposable-not-real", "different-disposable-only"))).rejects.toThrow(
        "PAYROLL_DEV_APPROVAL_SECRET_CHANGED_RESTART_REQUIRED");
    expect(devApprovalDedicatedEnabled()).toBe(true);
  });

  it("fails closed on unavailable GCP without caching a bad secret", async () => {
    await expect(prepareDevApprovalCredential(async () => {
      throw Error("synthetic temporary GCP outage");
    })).rejects.toThrow("synthetic temporary GCP outage");
    expect(devApprovalDedicatedEnabled()).toBe(false);
  });
});
