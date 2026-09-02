import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isTransientStreamError } from "./custom";

// This predicate decides whether a failed request is retried. Getting it wrong
// in either direction is costly: too eager and a rejected request is replayed
// several times against a shared endpoint; too shy and the endpoint restarting
// mid-answer surfaces to the user as a bare "terminated".

describe("isTransientStreamError", () => {
  test("undici's bare 'terminated' is transient", () => {
    // The exact shape observed when vLLM dropped the socket mid-stream: a
    // TypeError whose message is the single word "terminated".
    const err = new TypeError("terminated");
    assert.equal(isTransientStreamError(err), true);
  });

  test("a SocketError cause is found through the chain", () => {
    const cause = new Error("other side closed");
    cause.name = "SocketError";
    const err = new TypeError("terminated", { cause });
    assert.equal(isTransientStreamError(err), true);
  });

  test("'fetch failed' is transient", () => {
    assert.equal(isTransientStreamError(new TypeError("fetch failed")), true);
  });

  test("socket-level codes are transient", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"]) {
      const err = Object.assign(new Error("boom"), { code });
      assert.equal(isTransientStreamError(err), true, code);
    }
  });

  test("a code nested in the cause chain still counts", () => {
    const inner = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const outer = new Error("request failed", { cause: inner });
    assert.equal(isTransientStreamError(outer), true);
  });

  test("an HTTP status means the endpoint answered — never retry", () => {
    // A 400 will fail identically every time; replaying it wastes the
    // endpoint's capacity and delays the error the user needs to see.
    for (const status of [400, 401, 404, 422, 500]) {
      const err = Object.assign(new Error("Custom LLM request failed"), {
        status,
      });
      assert.equal(isTransientStreamError(err), false, String(status));
    }
  });

  test("a status wins even when the message looks transient", () => {
    const err = Object.assign(new Error("fetch failed"), { status: 400 });
    assert.equal(isTransientStreamError(err), false);
  });

  test("an ordinary error is not transient", () => {
    assert.equal(isTransientStreamError(new Error("bad tool arguments")), false);
    assert.equal(isTransientStreamError(new Error("")), false);
  });

  test("non-errors do not throw", () => {
    assert.equal(isTransientStreamError(undefined), false);
    assert.equal(isTransientStreamError(null), false);
    assert.equal(isTransientStreamError("terminated"), false);
  });

  test("a cyclic cause chain terminates", () => {
    // Guarding this matters: a self-referencing cause would otherwise hang the
    // request path rather than failing it.
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a }) as Error & { cause?: unknown };
    a.cause = b;
    assert.equal(isTransientStreamError(a), false);
  });
});
