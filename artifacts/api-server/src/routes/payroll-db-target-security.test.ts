import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { payrollDedicatedEnabled } from "./payroll-db";

const project = "xssrfshdrtdfupgqwfdw";
const login = "bizportal_payroll_dev";
const direct = (host = "db." + project + ".supabase.co",
  user = login, params = "sslmode=verify-full") =>
  "postgresql://" + encodeURIComponent(user) +
  ":synthetic-ci-only@" + host + ":5432/postgres" + (params ? "?" + params : "");
const pooler = (host = "aws-0-ap-southeast-2.pooler.supabase.com",
  user = login + "." + project) =>
  direct(host, user);

describe("dedicated DEV Payroll database target security", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYROLL_PG_E2E_URL", "");
    vi.stubEnv("PAYROLL_DATABASE_URL_DEV", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is absent without explicit dedicated credential and never enables in PROD", () => {
    expect(payrollDedicatedEnabled()).toBe(false);
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("PAYROLL_DATABASE_URL_DEV", direct());
    expect(payrollDedicatedEnabled()).toBe(false);
  });

  it("accepts exactly pinned DEV Supabase direct and project-scoped pooler", () => {
    for (const url of [
      direct(),
      pooler(),
      pooler().replace(":5432/", ":6543/"),
    ]) {
      vi.stubEnv("PAYROLL_DATABASE_URL_DEV", url);
      expect(payrollDedicatedEnabled()).toBe(true);
    }
  });

  it.each([
    ["wrong user", direct(undefined, "postgres")],
    ["wrong project", direct("db.nzdweipzckfszczzqtuw.supabase.co")],
    ["host substring spoof", direct("db." + project + ".supabase.co.attacker.test")],
    ["project-only spoof", direct("test." + project + ".example.test")],
    ["arbitrary project-containing host", direct("xssrfshdrtdfupgqwfdw.evil.example.test")],
    ["arbitrary pooler suffix", pooler("aws-0-ap-southeast-2.pooler.supabase.com.evil.test")],
    ["unscoped pooler identity", pooler(undefined, login)],
    ["missing TLS verification", direct(undefined, undefined, "")],
    ["TLS require", direct(undefined, undefined, "sslmode=require")],
    ["TLS disable", direct(undefined, undefined, "sslmode=disable")],
    ["duplicate TLS parameters", direct(undefined, undefined, "sslmode=verify-full&sslmode=disable")],
    ["host query override", direct(undefined, undefined, "sslmode=verify-full&host=evil.example.test")],
    ["user query override", direct(undefined, undefined, "sslmode=verify-full&user=postgres")],
    ["port query override", direct(undefined, undefined, "sslmode=verify-full&port=1234")],
    ["wrong database", direct().replace("/postgres?", "/another?")],
    ["missing password", direct().replace(":synthetic-ci-only@", "@")],
    ["wrong port", direct().replace(":5432/", ":9999/")],
  ])("rejects %s before creating a database pool", (_description, url) => {
    vi.stubEnv("PAYROLL_DATABASE_URL_DEV", url);
    expect(() => payrollDedicatedEnabled()).toThrow("PAYROLL_DEV_DATABASE_URL_REJECTED");
  });

  it("retains only exact existing disposable localhost PostgreSQL E2E fixture", () => {
    const fixture = "postgresql://postgres." + project +
      ":fixture-only@127.0.0.1:65432/payroll_ci";
    const roleUrl = "postgresql://" + login + "." + project +
      ":fixture-only@127.0.0.1:65432/payroll_ci";
    vi.stubEnv("PAYROLL_PG_E2E_URL", fixture);
    vi.stubEnv("PAYROLL_DATABASE_URL_DEV", roleUrl);
    expect(() => payrollDedicatedEnabled()).toThrow("PAYROLL_DEV_DATABASE_URL_REJECTED");

    vi.stubEnv("NODE_ENV", "test");
    expect(payrollDedicatedEnabled()).toBe(true);

    vi.stubEnv("PAYROLL_DATABASE_URL_DEV", roleUrl + "?sslmode=disable");
    expect(() => payrollDedicatedEnabled()).toThrow("PAYROLL_DEV_DATABASE_URL_REJECTED");

    vi.stubEnv("PAYROLL_DATABASE_URL_DEV", roleUrl);
    vi.stubEnv("PAYROLL_PG_E2E_URL", "");
    expect(() => payrollDedicatedEnabled()).toThrow("PAYROLL_DEV_DATABASE_URL_REJECTED");

    vi.stubEnv("PAYROLL_PG_E2E_URL", fixture);
    vi.stubEnv("NODE_ENV", "development");
    expect(() => payrollDedicatedEnabled()).toThrow("PAYROLL_DEV_DATABASE_URL_REJECTED");
  });
});
