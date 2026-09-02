import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { safeErrorLog, safeErrorMessage } from "./safeError";

// The `cause` chain is the whole point of these tests. Errors that cross the
// assistant stream boundary get re-wrapped, so the wrapper's own stack always
// points at the wrap site and says nothing about what actually failed — the
// original error survives only as `cause`.

describe("safeErrorLog", () => {
  test("omits causes when there are none", () => {
    const log = safeErrorLog(new Error("plain"));
    assert.equal(log.message, "plain");
    assert.equal(log.causes, undefined);
  });

  test("flattens the cause chain outermost-first", () => {
    const socket = new Error("other side closed");
    socket.name = "SocketError";
    const terminated = new TypeError("terminated", { cause: socket });
    const wrapped = new Error("Stream error", { cause: terminated });

    const log = safeErrorLog(wrapped);

    assert.equal(log.message, "Stream error");
    assert.deepEqual(
      log.causes?.map((c) => `${c.name}: ${c.message}`),
      ["TypeError: terminated", "SocketError: other side closed"],
    );
  });

  test("keeps each cause's own stack", () => {
    const original = new TypeError(
      "Cannot read properties of undefined (reading 'replace')",
    );
    const log = safeErrorLog(new Error("Stream error", { cause: original }));
    assert.match(log.causes?.[0]?.stack ?? "", /TypeError/);
  });

  test("redacts secrets inside causes", () => {
    const inner = new Error("Incorrect API key provided: sk-abcdef123456789");
    const log = safeErrorLog(new Error("upstream failed", { cause: inner }));
    const rendered = JSON.stringify(log.causes);
    assert.ok(!rendered.includes("sk-abcdef123456789"));
    assert.ok(rendered.includes("[redacted]"));
  });

  test("survives a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    const log = safeErrorLog(b);
    assert.ok((log.causes?.length ?? 0) > 0);
  });

  test("caps a long chain", () => {
    let err = new Error("root");
    for (let i = 0; i < 20; i++) err = new Error(`level ${i}`, { cause: err });
    assert.ok((safeErrorLog(err).causes?.length ?? 0) <= 5);
  });

  test("handles a non-Error cause", () => {
    const log = safeErrorLog(new Error("wrapped", { cause: "just a string" }));
    assert.equal(log.causes?.[0]?.message, "just a string");
  });

  test("safeErrorMessage is unchanged by the cause work", () => {
    assert.equal(safeErrorMessage(new Error("boom")), "boom");
    assert.equal(safeErrorMessage(undefined, "fallback"), "fallback");
  });
});
