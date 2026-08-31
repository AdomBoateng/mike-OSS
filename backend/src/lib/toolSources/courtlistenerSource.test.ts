import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  COURTLISTENER_TOOLS,
  COURTLISTENER_TOOL_NAMES,
  COURTLISTENER_SYSTEM_PROMPT,
} from "../legalSourcesTools/courtlistenerTools";
import { defaultToolSources, buildToolSourceContext } from "./index";
import { COURTLISTENER_SOURCE_ID } from "./courtlistenerSource";

// Isolate CourtListener: these assertions are about its own contribution, so
// other registered sources are switched off rather than being allowed to change
// the aggregate the registry returns.
const on = buildToolSourceContext({
  includeResearchTools: true,
  includeGhanaLaw: false,
});
const off = buildToolSourceContext({
  includeResearchTools: false,
  includeGhanaLaw: false,
});

describe("default registry: CourtListener", () => {
  test("is registered", () => {
    assert.ok(
      defaultToolSources.all().some((s) => s.id === COURTLISTENER_SOURCE_ID),
    );
  });

  // Regression guard: registry-assembled output must match the previous
  // hardcoded values in chatTools.ts exactly. Scoped to this source alone —
  // see the context definitions above.
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

  test("another enabled source does not displace CourtListener", () => {
    const both = buildToolSourceContext({
      includeResearchTools: true,
      includeGhanaLaw: true,
    });
    const names = defaultToolSources.tools(both).map((t) => t.function.name);
    for (const name of Object.values(COURTLISTENER_TOOL_NAMES)) {
      assert.ok(names.includes(name), `${name} missing when Ghana is also on`);
    }
    assert.match(defaultToolSources.systemPrompt(both), /US CASE LAW RESEARCH/);
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
