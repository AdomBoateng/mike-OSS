import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request } from "express";
import {
  CSRF_COOKIE,
  csrfTokenMatches,
  isSafeMethod,
  readCookie,
  sessionTokenFromRequest,
} from "./authCookies";

describe("authentication cookies", () => {
  it("reads an encoded cookie without confusing similarly named cookies", () => {
    assert.equal(readCookie("other=x; mike_session=a%2Eb%2Ec", "mike_session"), "a.b.c");
    assert.equal(readCookie("not_mike_session=x", "mike_session"), null);
  });

  it("requires equal CSRF cookie and header values", () => {
    const matching = {
      headers: { cookie: `${CSRF_COOKIE}=random-token`, "x-csrf-token": "random-token" },
    } as unknown as Request;
    const mismatched = {
      headers: { cookie: `${CSRF_COOKIE}=random-token`, "x-csrf-token": "other-token" },
    } as unknown as Request;
    assert.equal(csrfTokenMatches(matching), true);
    assert.equal(csrfTokenMatches(mismatched), false);
  });

  it("prefers the protected cookie during a rolling frontend upgrade", () => {
    const req = {
      headers: {
        cookie: "mike_session=cookie-token",
        authorization: "Bearer stale-legacy-token",
      },
    } as unknown as Request;
    assert.deepEqual(sessionTokenFromRequest(req), {
      token: "cookie-token",
      source: "cookie",
    });
  });

  it("recognizes methods that cannot mutate server state", () => {
    assert.equal(isSafeMethod("GET"), true);
    assert.equal(isSafeMethod("HEAD"), true);
    assert.equal(isSafeMethod("POST"), false);
  });
});
