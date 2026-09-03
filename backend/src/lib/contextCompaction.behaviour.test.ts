import { test, describe, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  compactIfNeeded,
  estimateTokens,
  type ChatApiMessage,
} from "./contextCompaction";

// compactIfNeeded calls the model to summarise, so these run against a local
// stand-in endpoint rather than a mock: it exercises the real request path and
// stays deterministic. `mode` decides how that endpoint behaves.

let mode: "ok" | "fail" = "ok";
let server: http.Server;
let baseUrl = "";
const REAL_ENV = { ...process.env };

before(async () => {
  server = http.createServer((req, res) => {
    if (mode === "fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "engine unavailable" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "User asked to redraft the lease (doc-1) to international standards; agreed to keep the Ghanaian governing-law clause.",
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  process.env = { ...REAL_ENV };
  mode = "ok";
});

function configure(windowTokens: number, keep = 4): void {
  process.env.CUSTOM_LLM_BASE_URL = baseUrl;
  process.env.CONTEXT_WINDOW_TOKENS = String(windowTokens);
  process.env.CONTEXT_COMPACT_AT = "0.7";
  process.env.CONTEXT_KEEP_RECENT_TURNS = String(keep);
}

/** A conversation long enough to cross any sensible threshold. */
function longConversation(turns: number, chars = 2000): ChatApiMessage[] {
  const messages: ChatApiMessage[] = [
    { role: "system", content: "SYSTEM CONTRACT: tools and document list." },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `Q${i} ` + "x".repeat(chars) });
    messages.push({ role: "assistant", content: `A${i} ` + "y".repeat(chars) });
  }
  return messages;
}

describe("compactIfNeeded", () => {
  test("leaves a short conversation completely alone", async () => {
    configure(1_000_000);
    const messages = longConversation(3);
    const out = await compactIfNeeded({ messages, model: "custom/test" });
    assert.equal(out.compacted, null);
    assert.equal(out.messages, messages, "expected the identical array back");
  });

  test("folds the oldest turns into a summary and shrinks the request", async () => {
    configure(4000, 4);
    const messages = longConversation(10);
    const out = await compactIfNeeded({ messages, model: "custom/test" });

    assert.ok(out.compacted, "expected compaction to happen");
    assert.equal(out.compacted!.degraded, false);
    assert.ok(
      out.compacted!.tokensAfter < out.compacted!.tokensBefore,
      `expected shrinkage: ${out.compacted!.tokensBefore} -> ${out.compacted!.tokensAfter}`,
    );
    assert.equal(estimateTokens(out.messages), out.compacted!.tokensAfter);
  });

  test("never touches the system message", async () => {
    // It carries the tool contract and document list; losing it changes how
    // the assistant behaves, which is far worse than a longer request.
    configure(4000, 4);
    const messages = longConversation(10);
    const out = await compactIfNeeded({ messages, model: "custom/test" });
    assert.equal(out.messages[0].role, "system");
    assert.equal(out.messages[0].content, messages[0].content);
  });

  test("keeps the most recent turns verbatim", async () => {
    // The tail is what the model is actually working on — summarising it would
    // blur the instruction the user just gave.
    configure(4000, 4);
    const messages = longConversation(10);
    const out = await compactIfNeeded({ messages, model: "custom/test" });
    const tail = messages.slice(-4);
    assert.deepEqual(out.messages.slice(-4), tail);
  });

  test("the summary is carried as a single labelled message", async () => {
    configure(4000, 4);
    const out = await compactIfNeeded({
      messages: longConversation(10),
      model: "custom/test",
    });
    const note = String(out.messages[1].content);
    assert.match(note, /condensed to stay within the context limit/i);
    assert.match(note, /governing-law clause/, "expected the model's summary text");
  });

  test("a failed summary degrades to an honest note, not a crash", async () => {
    // Losing the request entirely because the summariser is down would be the
    // worst outcome; the model is told what happened instead of being handed a
    // silently shortened history.
    mode = "fail";
    configure(4000, 4);
    const out = await compactIfNeeded({
      messages: longConversation(10),
      model: "custom/test",
    });
    assert.ok(out.compacted);
    assert.equal(out.compacted!.degraded, true);
    const note = String(out.messages[1].content);
    assert.match(note, /could not be summarised/i);
    assert.match(note, /say so rather than guessing/i);
  });

  test("does not compact when there is barely any history to fold", async () => {
    // Over the threshold on two enormous turns: there is nothing to move that
    // would not also be the turn the user is waiting on.
    configure(100, 4);
    const messages = longConversation(2);
    const out = await compactIfNeeded({ messages, model: "custom/test" });
    assert.equal(out.compacted, null);
  });
});
