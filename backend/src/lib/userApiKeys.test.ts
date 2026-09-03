import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { availableProvidersFrom } from "./userApiKeys";

// Env vars that envApiKey() consults, cleared before each test so the env
// fallback is deterministic regardless of the developer's shell / .env.
const API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CUSTOM_LLM_API_KEY",
  "COURTLISTENER_API_TOKEN",
] as const;

describe("availableProvidersFrom", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of API_KEY_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of API_KEY_ENV_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("is empty with no keys and no env", () => {
    assert.deepEqual([...availableProvidersFrom()], []);
    assert.deepEqual([...availableProvidersFrom({})], []);
  });

  test("includes a provider with a user-supplied key", () => {
    const providers = availableProvidersFrom({ courtlistener: "tok" });
    assert.ok(providers.has("courtlistener"));
    assert.ok(!providers.has("gemini"));
  });

  test("includes a provider via env fallback with no user key", () => {
    process.env.COURTLISTENER_API_TOKEN = "env-tok";
    assert.ok(availableProvidersFrom().has("courtlistener"));
  });

  test("ignores whitespace-only and null user keys", () => {
    const providers = availableProvidersFrom({
      courtlistener: "   ",
      gemini: null,
    });
    assert.deepEqual([...providers], []);
  });

  test("combines user keys and env fallbacks across providers", () => {
    process.env.OPENAI_API_KEY = "env-openai";
    const providers = availableProvidersFrom({ gemini: "user-gemini" });
    assert.ok(providers.has("gemini"));
    assert.ok(providers.has("openai"));
    assert.ok(!providers.has("claude"));
  });

  test("claude resolves from either ANTHROPIC or CLAUDE env var", () => {
    process.env.CLAUDE_API_KEY = "env-claude";
    assert.ok(availableProvidersFrom().has("claude"));
  });
});
