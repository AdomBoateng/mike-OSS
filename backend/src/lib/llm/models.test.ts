import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  customModelLabel,
  customModelName,
  isCustomModel,
  providerForModel,
  toCustomModelId,
} from "./models";

describe("custom model ids", () => {
  test("round-trips a raw endpoint name through the custom/ namespace", () => {
    const id = toCustomModelId("qwen3_6_35b");
    assert.equal(id, "custom/qwen3_6_35b");
    assert.ok(isCustomModel(id));
    assert.equal(customModelName(id), "qwen3_6_35b");
    assert.equal(providerForModel(id), "custom");
  });
});

describe("customModelLabel", () => {
  test("maps the deployed vLLM models to their display names", () => {
    assert.equal(customModelLabel("qwen3_6_35b"), "Qwen3.6-35b");
    assert.equal(customModelLabel("qwen3_8_27b"), "Qwen3.8-27b");
    assert.equal(customModelLabel("qwen3_8_flash_next"), "Qwen3.8-Flash-Next");
  });

  test("matches case-insensitively", () => {
    assert.equal(customModelLabel("QWEN3_6_35B"), "Qwen3.6-35b");
  });

  test("an unmapped model still appears, under its raw id", () => {
    assert.equal(customModelLabel("llama3.2"), "llama3.2");
  });

  test("labelling never changes the id sent to the endpoint", () => {
    // The endpoint only ever sees customModelName(); the label is display-only.
    const id = toCustomModelId("qwen3_6_35b");
    assert.equal(customModelName(id), "qwen3_6_35b");
    assert.notEqual(customModelName(id), customModelLabel("qwen3_6_35b"));
  });
});
