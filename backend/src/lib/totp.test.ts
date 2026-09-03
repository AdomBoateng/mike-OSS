import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { authenticator } from "otplib";

import { generateSecret, keyuri, verifyToken } from "./totp";

describe("totp", () => {
  test("generateSecret returns a non-empty base32 secret", () => {
    const secret = generateSecret();
    assert.ok(secret.length >= 16);
    assert.match(secret, /^[A-Z2-7]+$/); // base32 alphabet
  });

  test("verifyToken accepts a freshly generated code", () => {
    const secret = generateSecret();
    const code = authenticator.generate(secret);
    assert.equal(verifyToken(secret, code), true);
  });

  test("verifyToken rejects a wrong code", () => {
    const secret = generateSecret();
    const code = authenticator.generate(secret);
    // Flip to a definitely-different 6-digit code.
    const wrong = code === "000000" ? "111111" : "000000";
    assert.equal(verifyToken(secret, wrong), false);
  });

  test("verifyToken rejects non-6-digit input without throwing", () => {
    const secret = generateSecret();
    assert.equal(verifyToken(secret, "12345"), false);
    assert.equal(verifyToken(secret, "abcdef"), false);
    assert.equal(verifyToken(secret, ""), false);
    assert.equal(verifyToken(secret, "1234567"), false);
  });

  test("keyuri embeds issuer and account", () => {
    const uri = keyuri("jane@example.com", generateSecret());
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /issuer=Mike/);
    assert.match(uri, /jane%40example\.com|jane@example\.com/);
  });
});
