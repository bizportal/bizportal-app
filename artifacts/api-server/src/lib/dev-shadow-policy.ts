/**
 * Explicitly isolate a no-dispatch DEV shadow runtime from embedded workers.
 * Not a network sandbox: do not pass external credentials or connect PROD.
 */
export function isBizPortalDevShadowMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const requested = env.BIZPORTAL_SHADOW_MODE?.trim().toLowerCase() === "true";
  if (!requested) return false;
  if (env.APP_ENV?.trim().toLowerCase() !== "development" ||
      env.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new Error("BIZPORTAL_SHADOW_MODE_REQUIRES_DEV");
  }
  return true;
}

export function shouldScheduleEmbeddedJobs(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isBizPortalDevShadowMode(env);
}
