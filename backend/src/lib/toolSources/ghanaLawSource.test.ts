import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { defaultToolSources, buildToolSourceContext } from "./index";
import { GHANA_LAW_SOURCE_ID } from "./ghanaLawSource";
import { COURTLISTENER_SOURCE_ID } from "./courtlistenerSource";
import { GHANA_LAW_TOOL_NAMES } from "../legalSourcesTools/ghanaLawTools";

const REAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...REAL_ENV };
});

const ids = (ctx: ReturnType<typeof buildToolSourceContext>) =>
  defaultToolSources.enabled(ctx).map((s) => s.id);

describe("ghanaLawSource gating", () => {
  test("enabled by default, like legal_research_us", () => {
    assert.ok(ids(buildToolSourceContext({})).includes(GHANA_LAW_SOURCE_ID));
  });

  test("the per-user Ghana toggle turns it off", () => {
    const off = buildToolSourceContext({ includeGhanaLaw: false });
    assert.ok(!ids(off).includes(GHANA_LAW_SOURCE_ID));
    assert.equal(defaultToolSources.tools(off).some(
      (t) => t.function.name.startsWith("ghana_law_"),
    ), false);
  });

  test("GHANA_LAW_ENABLED=false disables it instance-wide", () => {
    process.env.GHANA_LAW_ENABLED = "false";
    assert.ok(!ids(buildToolSourceContext({})).includes(GHANA_LAW_SOURCE_ID));
  });

  test("the two jurisdictions gate independently", () => {
    // The bug this guards: while CourtListener was the only source, one boolean
    // meant "research on/off". Turning US research off must not silence Ghana.
    const ghanaOnly = buildToolSourceContext({
      includeResearchTools: false,
      includeGhanaLaw: true,
    });
    assert.deepEqual(ids(ghanaOnly), [GHANA_LAW_SOURCE_ID]);

    const usOnly = buildToolSourceContext({
      includeResearchTools: true,
      includeGhanaLaw: false,
    });
    assert.deepEqual(ids(usOnly), [COURTLISTENER_SOURCE_ID]);
  });

  test("the legacy boolean form still means the US flag", () => {
    assert.ok(!ids(buildToolSourceContext(false)).includes(COURTLISTENER_SOURCE_ID));
    assert.ok(ids(buildToolSourceContext(true)).includes(COURTLISTENER_SOURCE_ID));
  });
});

describe("ghanaLawSource contents", () => {
  const ctx = buildToolSourceContext({});

  test("contributes its four tools", () => {
    const names = defaultToolSources.tools(ctx).map((t) => t.function.name);
    for (const n of Object.values(GHANA_LAW_TOOL_NAMES)) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  });

  test("every tool routes back to the Ghana source", () => {
    for (const n of Object.values(GHANA_LAW_TOOL_NAMES)) {
      assert.equal(defaultToolSources.sourceForTool(n, ctx)?.id, GHANA_LAW_SOURCE_ID);
    }
  });

  test("a disabled source owns no tool names for routing", () => {
    const off = buildToolSourceContext({ includeGhanaLaw: false });
    assert.equal(
      defaultToolSources.sourceForTool(GHANA_LAW_TOOL_NAMES.search, off),
      undefined,
    );
  });

  test("needs no API key provider — the repository is open", () => {
    const src = defaultToolSources.all().find((s) => s.id === GHANA_LAW_SOURCE_ID);
    assert.equal(src?.provider, undefined);
  });

  test("the prompt states the as-enacted limit and the scan caveat", () => {
    const prompt = defaultToolSources.systemPrompt(ctx);
    assert.match(prompt, /as enacted/i);
    assert.match(prompt, /amendment/i);
    assert.match(prompt, /scan/i);
    // It must not imply case-law coverage that does not exist.
    assert.match(prompt, /no Ghanaian case-law source/i);
  });

  test("both jurisdictions' prompts appear when both are on", () => {
    const prompt = defaultToolSources.systemPrompt(ctx);
    assert.match(prompt, /US CASE LAW RESEARCH/);
    assert.match(prompt, /GHANA LEGISLATION/);
  });
});
