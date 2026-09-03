import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { defaultToolSources, buildToolSourceContext } from "./index";
import { WEB_SEARCH_SOURCE_ID } from "./webSearchSource";
import { WEB_SEARCH_TOOL_NAMES } from "../legalSourcesTools/webSearchTools";

const REAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...REAL_ENV };
});

function withInstance(): void {
  process.env.SEARXNG_BASE_URL = "http://search.internal";
  delete process.env.WEB_SEARCH_ENABLED;
}

const toolNames = (ctx: ReturnType<typeof buildToolSourceContext>) =>
  defaultToolSources.tools(ctx).map((t) => (t as { function: { name: string } }).function.name);

describe("webSearchSource gating", () => {
  test("offered when an instance is configured and the flag is on", () => {
    withInstance();
    const ctx = buildToolSourceContext({ includeWebSearch: true });
    assert.ok(toolNames(ctx).includes(WEB_SEARCH_TOOL_NAMES.search));
    assert.equal(
      defaultToolSources.sourceForTool(WEB_SEARCH_TOOL_NAMES.search, ctx)?.id,
      WEB_SEARCH_SOURCE_ID,
    );
  });

  test("NOT offered when no instance is configured, whatever the flag says", () => {
    // The deployment gate must win: without an instance there is nowhere to
    // send the query, and a firm that has not set one up should never see the
    // tool appear because a user preference defaulted on.
    delete process.env.SEARXNG_BASE_URL;
    const ctx = buildToolSourceContext({ includeWebSearch: true });
    assert.ok(!toolNames(ctx).includes(WEB_SEARCH_TOOL_NAMES.search));
  });

  test("NOT offered when the user has turned it off", () => {
    withInstance();
    const ctx = buildToolSourceContext({ includeWebSearch: false });
    assert.ok(!toolNames(ctx).includes(WEB_SEARCH_TOOL_NAMES.search));
  });

  test("killable instance-wide without unsetting the URL", () => {
    withInstance();
    process.env.WEB_SEARCH_ENABLED = "false";
    const ctx = buildToolSourceContext({ includeWebSearch: true });
    assert.ok(!toolNames(ctx).includes(WEB_SEARCH_TOOL_NAMES.search));
  });

  test("its prompt appears only when the source does", () => {
    withInstance();
    const on = defaultToolSources.systemPrompt(
      buildToolSourceContext({ includeWebSearch: true }),
    );
    const off = defaultToolSources.systemPrompt(
      buildToolSourceContext({ includeWebSearch: false }),
    );
    assert.match(on, /WEB SEARCH:/);
    assert.ok(!/WEB SEARCH:/.test(off));
  });

  test("turning web search off leaves the legislation sources alone", () => {
    // Sources gate on their own flag; one being off must not disturb another.
    withInstance();
    const ctx = buildToolSourceContext({
      includeWebSearch: false,
      includeGhanaLaw: true,
      includeResearchTools: true,
    });
    const names = toolNames(ctx);
    assert.ok(!names.includes(WEB_SEARCH_TOOL_NAMES.search));
    assert.ok(names.some((n) => n.startsWith("ghana_law_")));
  });

  test("a research-free context offers no web search even by default", () => {
    // Flags default to ON, so bulk extraction has to name this one explicitly.
    // routes/tabular.ts does; this asserts the behaviour it depends on.
    withInstance();
    const ctx = buildToolSourceContext({
      includeResearchTools: false,
      includeGhanaLaw: false,
      includeWebSearch: false,
    });
    assert.equal(toolNames(ctx).length, 0);
  });
});
