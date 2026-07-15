// TOTP primitives for MFA, thin wrappers over otplib. A ±1 step window (30s
// each) tolerates minor clock skew between the server and the user's device.

import { authenticator } from "otplib";

// Applied process-wide; otplib's authenticator is a singleton.
authenticator.options = { window: 1 };

const ISSUER = "Mike";

/** Generate a new base32 TOTP secret. */
export function generateSecret(): string {
  return authenticator.generateSecret();
}

/** Build the otpauth:// URI an authenticator app scans, labelled by user. */
export function keyuri(accountName: string, secret: string): string {
  return authenticator.keyuri(accountName || "user", ISSUER, secret);
}

/** Verify a 6-digit code against a secret (within the ±1 step window). */
export function verifyToken(secret: string, code: string): boolean {
  const token = (code ?? "").trim();
  if (!/^\d{6}$/.test(token)) return false;
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}
