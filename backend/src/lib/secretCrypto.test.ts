import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { encryptSecret, decryptSecret } from "./secretCrypto";

describe("secretCrypto", () => {
  let saved: string | undefined;
  before(() => {
    saved = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret-please-change";
  });
  after(() => {
    if (saved === undefined) delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    else process.env.USER_API_KEYS_ENCRYPTION_SECRET = saved;
  });

  const SALT = "mike-totp-v1";

  test("round-trips a value", () => {
    const enc = encryptSecret("JBSWY3DPEHPK3PXP", SALT);
    assert.equal(decryptSecret(enc, SALT), "JBSWY3DPEHPK3PXP");
  });

  test("produces a fresh iv each call (non-deterministic ciphertext)", () => {
    const a = encryptSecret("same", SALT);
    const b = encryptSecret("same", SALT);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.notEqual(a.iv, b.iv);
  });

  test("returns null when decrypting under a different salt", () => {
    const enc = encryptSecret("secret", SALT);
    assert.equal(decryptSecret(enc, "mike-other-v1"), null);
  });

  test("returns null on a tampered auth tag", () => {
    const enc = encryptSecret("secret", SALT);
    const tampered = { ...enc, authTag: Buffer.alloc(16).toString("base64") };
    assert.equal(decryptSecret(tampered, SALT), null);
  });

  test("returns null on tampered ciphertext", () => {
    const enc = encryptSecret("secret", SALT);
    const tampered = {
      ...enc,
      ciphertext: Buffer.from("garbage").toString("base64"),
    };
    assert.equal(decryptSecret(tampered, SALT), null);
  });
});
