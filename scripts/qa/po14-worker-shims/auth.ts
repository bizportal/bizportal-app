/** No HTTP authentication may be fabricated by a worker.
 * The parent endpoint verifies its real session and passes a VerifiedActor.
 * Exported service functions receive that actor; router auth calls fail closed.
 */
function forbidden(): never { throw new Error("HTTP_AUTH_FORBIDDEN_IN_PO14_WORKER"); }
export const getDevSession = forbidden;
export const getProductionSession = forbidden;
export const getProductionUser = forbidden;
export const getFinanceCompanyScope = forbidden;
export const isApprovedFinanceGlobalSuperAdmin = forbidden;
export const isApprovedFinanceGlobalCompany = forbidden;
export const isDevelopmentEnvironment = () => process.env.APP_ENV === "development";
