import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  compactionThreshold,
  estimateMessageTokens,
  estimateTokens,
  type ChatApiMessage,
} from "./contextCompaction";

const REAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...REAL_ENV };
});

function msg(role: string, content: string): ChatApiMessage {
  return { role, content };
}

describe("estimateMessageTokens", () => {
  test("counts the body, not just the envelope", () => {
    const short = estimateMessageTokens(msg("user", "hi"));
    const long = estimateMessageTokens(msg("user", "x".repeat(3500)));
    assert.ok(long > short * 50, `expected growth with content: ${short} -> ${long}`);
  });

  test("structured content still costs tokens", () => {
    // Tool calls occupy the window as surely as prose. Counting only strings
    // would let a turn full of tool arguments slip past the threshold.
    const withToolCall: ChatApiMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", function: { name: "read_document", arguments: "x".repeat(2000) } },
      ],
    };
    assert.ok(estimateMessageTokens(withToolCall) > 400);
  });

  test("a null body costs only the envelope", () => {
    assert.ok(estimateMessageTokens({ role: "assistant", content: null }) <= 5);
  });

  test("the estimate runs high rather than low", () => {
    // 3.5 chars/token against an English average nearer 4: compacting one turn
    // early is cheap, discovering the window is full is not.
    const text = "The lease shall commence on the date of execution. ".repeat(20);
    const estimated = estimateMessageTokens(msg("user", text));
    const generous = text.length / 4;
    assert.ok(estimated > generous, `${estimated} should exceed ${generous}`);
  });
});

describe("estimateTokens", () => {
  test("sums the conversation", () => {
    const messages = [msg("system", "rules"), msg("user", "a"), msg("assistant", "b")];
    assert.equal(
      estimateTokens(messages),
      messages.reduce((n, m) => n + estimateMessageTokens(m), 0),
    );
  });

  test("an empty conversation is zero", () => {
    assert.equal(estimateTokens([]), 0);
  });
});

describe("compactionThreshold", () => {
  test("is a fraction of the configured window", () => {
    process.env.CONTEXT_WINDOW_TOKENS = "10000";
    process.env.CONTEXT_COMPACT_AT = "0.5";
    assert.equal(compactionThreshold(), 5000);
  });

  test("is re-read from the environment, not frozen at import", () => {
    // The rest of this codebase resolves config lazily so a deployment can
    // retune without a rebuild, and so tests do not need module reloading.
    process.env.CONTEXT_WINDOW_TOKENS = "8000";
    process.env.CONTEXT_COMPACT_AT = "0.5";
    assert.equal(compactionThreshold(), 4000);
    process.env.CONTEXT_WINDOW_TOKENS = "16000";
    assert.equal(compactionThreshold(), 8000);
  });
});
