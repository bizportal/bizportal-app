import { describe, expect, it } from "vitest";
import { computeDatabasePoolMax } from "@workspace/db";

const direct =
  "postgresql://bizportal_pr81_otp_login_dev:synthetic@db.example.invalid:5432/postgres";
const pooler =
  "postgresql://bizportal_pr81_otp_login_dev.xssrfshdrtdfupgqwfdw:synthetic@pooler.example.invalid:6543/postgres";
const ordinary =
  "postgresql://bizportal-dev-app:synthetic@db.example.invalid/postgres";

describe("PR #81 restricted DEV OTP auth pool connection limit", () => {
  it("caps the restricted CST-DEV login to one connection in production-mode Node", () => {
    expect(computeDatabasePoolMax(direct, {
      APP_ENV: "development", NODE_ENV: "production",
    })).toBe(1);
    expect(computeDatabasePoolMax(pooler, {
      APP_ENV: "development", NODE_ENV: "production",
    })).toBe(1);
  });

  it("cannot raise the restricted login above its one-connection database limit", () => {
    expect(computeDatabasePoolMax(direct, {
      APP_ENV: "development", NODE_ENV: "production", DB_POOL_MAX: "5",
    })).toBe(1);
  });

  it("keeps existing production and unrelated DEV sizing unchanged", () => {
    expect(computeDatabasePoolMax(ordinary, {
      APP_ENV: "production", NODE_ENV: "production",
    })).toBe(2);
    expect(computeDatabasePoolMax(ordinary, {
      APP_ENV: "development", NODE_ENV: "development",
    })).toBe(5);
    expect(computeDatabasePoolMax(ordinary, {
      APP_ENV: "development", NODE_ENV: "production", DB_POOL_MAX: "3",
    })).toBe(3);
  });

  it("does not infer a restricted role from a similarly prefixed username", () => {
    expect(computeDatabasePoolMax(
      "postgresql://bizportal_pr81_otp_login_dev_fake:synthetic@db.example.invalid/postgres",
      { APP_ENV: "development", NODE_ENV: "production" },
    )).toBe(2);
  });

  it("does not affect production even when the dedicated name is used", () => {
    expect(computeDatabasePoolMax(direct, {
      APP_ENV: "production", NODE_ENV: "production",
    })).toBe(2);
  });
});
