import { test, describe, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { streamCustom } from "./custom";

// A long generation can stall for minutes while the model is still working.
// undici's default body timeout is 300s, so it used to kill those requests
// mid-answer — the user saw "terminated" after a partial response. These tests
// pin the timeout to something small and prove it is actually configurable,
// because the dispatcher only applies when the Agent and the fetch come from
// the same undici instance; passing it to Node's global fetch silently does
// nothing, which is how the first attempt at this failed.

const GAP_MS = 2500;
let server: http.Server;
let baseUrl = "";
const REAL_ENV = { ...process.env };

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "start " } }] })}\n\n`,
    );
    setTimeout(() => {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "end" } }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    }, GAP_MS);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  process.env = { ...REAL_ENV };
});

async function streamWith(bodyTimeoutMs: string) {
  process.env.CUSTOM_LLM_BASE_URL = baseUrl;
  process.env.CUSTOM_LLM_BODY_TIMEOUT_MS = bodyTimeoutMs;
  // One attempt: retries would mask whether the timeout itself changed.
  process.env.CUSTOM_LLM_STREAM_RETRIES = "1";
  let text = "";
  let error: string | null = null;
  try {
    await streamCustom({
      model: "custom/test",
      systemPrompt: "s",
      messages: [{ role: "user", content: "q" }],
      callbacks: { onContentDelta: (d: string) => { text += d; } },
    } as never);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { text, error };
}

describe("streaming body timeout", () => {
  test("a gap longer than the timeout kills the stream", async () => {
    // Reproduces the production symptom: partial output, then "terminated".
    const { text, error } = await streamWith("800");
    assert.ok(error, "expected the stream to fail");
    assert.equal(text, "start ", "the first chunk should still have arrived");
  });

  test("raising the timeout lets the same slow stream finish", async () => {
    // The whole point: the connection was alive, only the guard was too tight.
    const { text, error } = await streamWith("30000");
    assert.equal(error, null, `unexpected failure: ${error}`);
    assert.equal(text, "start end");
  });

  test("the timeout is read per call, not frozen at import", async () => {
    // Both cases above ran in one process; if the value were captured at module
    // load the second could never have passed. Asserting it directly so a
    // refactor back to a module-level const fails here rather than in
    // production five minutes into a redraft.
    const tight = await streamWith("800");
    const loose = await streamWith("30000");
    assert.ok(tight.error);
    assert.equal(loose.error, null);
  });
});
