import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { validateToolCallArguments } from "./toolArgs";
import { TOOLS } from "./chatTools";
import type { OpenAIToolSchema } from "./llm";

const tools = TOOLS as unknown as OpenAIToolSchema[];

// The crash this guards against is concrete: `generate_docx` reads
// `args.title as string` and immediately calls `.replace()` on it, so a call
// with no title throws "Cannot read properties of undefined (reading
// 'replace')" and takes the whole assistant stream down with it.

describe("validateToolCallArguments", () => {
  test("rejects generate_docx with no arguments at all", () => {
    const result = validateToolCallArguments("generate_docx", "{}", tools);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.problem : "", /title/);
  });

  test("rejects a title of the wrong type", () => {
    const result = validateToolCallArguments(
      "generate_docx",
      JSON.stringify({ title: 42, sections: [] }),
      tools,
    );
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.problem : "",
      /'title' must be a string, got number/,
    );
  });

  test("accepts a well-formed call", () => {
    const result = validateToolCallArguments(
      "generate_docx",
      JSON.stringify({ title: "Memo", sections: [] }),
      tools,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true ? result.args.title : null, "Memo");
  });

  test("rejects truncated argument JSON", () => {
    const result = validateToolCallArguments(
      "generate_docx",
      '{"title": "Mem',
      tools,
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.problem : "", /not valid JSON/);
  });

  test("rejects a non-object argument payload", () => {
    const result = validateToolCallArguments("read_document", "[1,2]", tools);
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.problem : "",
      /must be a JSON object/,
    );
  });

  test("catches a missing doc_id on read_document", () => {
    const result = validateToolCallArguments("read_document", "{}", tools);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.problem : "", /doc_id/);
  });

  test("empty arguments are fine for a tool that requires nothing", () => {
    const noArgTools: OpenAIToolSchema[] = [
      {
        type: "function",
        function: {
          name: "ping",
          description: "",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    assert.equal(validateToolCallArguments("ping", "", noArgTools).ok, true);
  });

  test("passes through a tool with no schema registered", () => {
    const result = validateToolCallArguments("mcp_whatever", "{}", []);
    assert.equal(result.ok, true);
  });

  test("an empty string is a present value, not a missing one", () => {
    const result = validateToolCallArguments(
      "find_in_document",
      JSON.stringify({ doc_id: "doc-0", query: "" }),
      tools,
    );
    assert.equal(result.ok, true);
  });
});
