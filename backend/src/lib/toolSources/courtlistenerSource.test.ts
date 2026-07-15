import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  COURTLISTENER_TOOLS,
  COURTLISTENER_TOOL_NAMES,
  COURTLISTENER_SYSTEM_PROMPT,
} from "../legalSourcesTools/courtlistenerTools";
import { defaultToolSources, buildToolSourceContext } from "./index";
import { COURTLISTENER_SOURCE_ID } from "./courtlistenerSource";

const on = buildToolSourceContext(true);
const off = buildToolSourceContext(false);

describe("default registry: CourtListener", () => {
  test("is registered", () => {
    assert.ok(
      defaultToolSources.all().some((s) => s.id === COURTLISTENER_SOURCE_ID),
    );
  });

  // Regression guard: registry-assembled output must match the previous
  // hardcoded values in chatTools.ts exactly.
  test("assembled tools match COURTLISTENER_TOOLS when research is on", () => {
    assert.deepEqual(defaultToolSources.tools(on), COURTLISTENER_TOOLS);
  });

  test("assembled system prompt matches COURTLISTENER_SYSTEM_PROMPT", () => {
    assert.equal(defaultToolSources.systemPrompt(on), COURTLISTENER_SYSTEM_PROMPT);
  });

  test("contributes nothing when research is off", () => {
    assert.deepEqual(defaultToolSources.tools(off), []);
    assert.equal(defaultToolSources.systemPrompt(off), "");
  });

  test("routes every CourtListener tool name to the source", () => {
    for (const name of Object.values(COURTLISTENER_TOOL_NAMES)) {
      assert.equal(
        defaultToolSources.sourceForTool(name, on)?.id,
        COURTLISTENER_SOURCE_ID,
        `expected ${name} to route to courtlistener`,
      );
    }
  });

  test("does not route CourtListener tools when research is off", () => {
    assert.equal(
      defaultToolSources.sourceForTool(
        COURTLISTENER_TOOL_NAMES.searchCaseLaw,
        off,
      ),
      undefined,
    );
  });
});
