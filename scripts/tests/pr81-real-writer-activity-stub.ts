/** Do not publish a real activity log, email or notification from a rollback test. */
export async function logActivity(_args:unknown):Promise<void> {
 throw new Error("DISPOSABLE_AFTER_COMMIT_CALLBACK_MUST_NOT_RUN");
}
