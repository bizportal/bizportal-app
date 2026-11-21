import type { AuthUser } from "@shared/api-client-react";

/**
 * A successful OTP verification response is not proof that a signed HttpOnly
 * cookie was stored and accepted by the server. Only a fresh authenticated
 * server profile can authorize the client to display a logged-in identity.
 */
export async function confirmOtpServerSession(
  expected: AuthUser,
  normalizedEmail: string,
  fetchSession: typeof fetch = fetch,
): Promise<AuthUser | null> {
  const response = await fetchSession("/api/auth/user", {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return null;

  const payload = await response.json().catch(() => null) as { user?: AuthUser } | null;
  const verified = payload?.user;
  if (!verified ||
      verified.email?.trim().toLowerCase() !== normalizedEmail ||
      verified.id !== expected.id ||
      verified.role !== expected.role) {
    return null;
  }
  return verified;
}
