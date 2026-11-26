export type EmailLoginMode = "dev" | "email";

export function resolveEmailLoginMode({
  email,
  password,
  devEmails,
  signedOtpRequired = false,
}: {
  email: string;
  password: string;
  devEmails: readonly string[];
  signedOtpRequired?: boolean;
}): EmailLoginMode {
  if (signedOtpRequired) return "email";
  const normalizedEmail = email.trim().toLowerCase();
  const isConfiguredDevEmail = devEmails.some(
    (devEmail) => devEmail.trim().toLowerCase() === normalizedEmail,
  );

  return !password && isConfiguredDevEmail ? "dev" : "email";
}