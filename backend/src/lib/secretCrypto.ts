// Symmetric encryption for secrets stored at rest (TOTP secrets, and — in
// spirit — user API keys). AES-256-GCM with a key derived from
// USER_API_KEYS_ENCRYPTION_SECRET via scrypt. Each domain passes its own scrypt
// salt so keys are not shared across features.
//
// The same scheme is currently inlined in userApiKeys.ts (kept as-is to avoid
// churn on that working path); this module is the reusable extraction.

import crypto from "crypto";

export interface EncryptedSecret {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

function encryptionKey(salt: string): Buffer {
  const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured");
  }
  return crypto.scryptSync(secret, salt, 32);
}

export function encryptSecret(value: string, salt: string): EncryptedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(salt), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt a value produced by encryptSecret. Returns null on any failure
 * (wrong key, tampered ciphertext/tag) rather than throwing. */
export function decryptSecret(
  enc: EncryptedSecret,
  salt: string,
): string | null {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(salt),
      Buffer.from(enc.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(enc.authTag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(enc.ciphertext, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}
