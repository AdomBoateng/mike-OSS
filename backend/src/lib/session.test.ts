import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { signSession, verifySession } from "./session";

describe("session tokens", () => {
  let saved: string | undefined;
  before(() => {
    saved = process.env.SESSION_JWT_SECRET;
    process.env.SESSION_JWT_SECRET = "test-secret-abc";
  });
  after(() => {
    if (saved === undefined) delete process.env.SESSION_JWT_SECRET;
    else process.env.SESSION_JWT_SECRET = saved;
  });

  const claims = { sub: "user-1", email: "a@x.com", ldapUid: "auser" };

  test("sign then verify round-trips the claims", () => {
    const token = signSession(claims);
    // verifySession normalises mfaVerified to false when the claim is absent.
    assert.deepEqual(verifySession(token), { ...claims, mfaVerified: false });
  });

  test("preserves mfaVerified=true through a round-trip", () => {
    const token = signSession({ ...claims, mfaVerified: true });
    assert.equal(verifySession(token)?.mfaVerified, true);
  });

  test("verify rejects a garbage token", () => {
    assert.equal(verifySession("not.a.jwt"), null);
  });

  test("verify rejects a token signed with a different secret", () => {
    const token = signSession(claims);
    process.env.SESSION_JWT_SECRET = "a-different-secret";
    assert.equal(verifySession(token), null);
    process.env.SESSION_JWT_SECRET = "test-secret-abc";
  });

  test("verify rejects an expired token", () => {
    const token = signSession(claims, -1); // already expired
    assert.equal(verifySession(token), null);
  });
});
