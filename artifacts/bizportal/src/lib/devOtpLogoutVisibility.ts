/** A Hostinger DEV deployment can use a production-built frontend. */
export function shouldShowDevLogout(isDevBuild: boolean, requiresSignedOtp: boolean): boolean {
  return isDevBuild || requiresSignedOtp;
}
