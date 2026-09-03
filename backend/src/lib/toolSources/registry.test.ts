import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ToolSourceRegistry, toolNamesOf } from "./registry";
import type { ToolSource, ToolSourceContext } from "./types";

function tool(name: string) {
  return {
    type: "function" as const,
    function: {
      name,
      description: `desc for ${name}`,
      parameters: { type: "object", properties: {} },
    },
  };
}

function source(over: Partial<ToolSource> & { id: string }): ToolSource {
  return {
    tools: [tool(`${over.id}_a`), tool(`${over.id}_b`)],
    ...over,
  };
}

const ctx: ToolSourceContext = {
  availableProviders: new Set(),
  flags: {},
};

describe("toolNamesOf", () => {
  test("derives tool names from schemas", () => {
    assert.deepEqual(toolNamesOf(source({ id: "x" })), ["x_a", "x_b"]);
  });
});

describe("ToolSourceRegistry registration", () => {
  test("preserves registration order", () => {
    const reg = new ToolSourceRegistry();
    reg.register(source({ id: "first" }));
    reg.register(source({ id: "second" }));
    assert.deepEqual(
      reg.all().map((s) => s.id),
      ["first", "second"],
    );
  });

  test("rejects a duplicate id", () => {
    const reg = new ToolSourceRegistry();
    reg.register(source({ id: "dup" }));
    assert.throws(
      () => reg.register(source({ id: "dup" })),
      /already registered/,
    );
  });

  test("rejects a tool-name collision across sources", () => {
    const reg = new ToolSourceRegistry();
    reg.register({ id: "one", tools: [tool("shared")] });
    assert.throws(
      () => reg.register({ id: "two", tools: [tool("shared")] }),
      /already provided by "one"/,
    );
  });
});

describe("ToolSourceRegistry assembly", () => {
  test("tools() concatenates enabled sources in order", () => {
    const reg = new ToolSourceRegistry();
    reg.register(source({ id: "x" }));
    reg.register(source({ id: "y" }));
    assert.deepEqual(
      reg.tools(ctx).map((t) => t.function.name),
      ["x_a", "x_b", "y_a", "y_b"],
    );
  });

  test("tools() returns copies, not the source's own schema objects", () => {
    const reg = new ToolSourceRegistry();
    const src = source({ id: "x" });
    reg.register(src);
    const [first] = reg.tools(ctx);
    assert.notEqual(first, src.tools[0]);
    assert.equal(first.function.name, src.tools[0].function.name);
  });

  test("systemPrompt() joins non-empty fragments with a blank line", () => {
    const reg = new ToolSourceRegistry();
    reg.register(source({ id: "x", systemPrompt: "Alpha rules." }));
    reg.register(source({ id: "y" })); // no prompt
    reg.register(source({ id: "z", systemPrompt: "  Zeta rules.  " }));
    assert.equal(reg.systemPrompt(ctx), "Alpha rules.\n\nZeta rules.");
  });

  test("systemPrompt() is empty when no enabled source has a prompt", () => {
    const reg = new ToolSourceRegistry();
    reg.register(source({ id: "x" }));
    assert.equal(reg.systemPrompt(ctx), "");
  });
});

describe("ToolSourceRegistry gating", () => {
  const enabledWhenFlag: ToolSource = {
    id: "gated",
    tools: [tool("gated_a")],
    systemPrompt: "Gated rules.",
    isEnabled: (c) => c.flags.on === true,
  };

  test("disabled source contributes no tools or prompt", () => {
    const reg = new ToolSourceRegistry();
    reg.register(enabledWhenFlag);
    const off = { availableProviders: new Set(), flags: { on: false } };
    assert.deepEqual(reg.enabled(off).map((s) => s.id), []);
    assert.deepEqual(reg.tools(off), []);
    assert.equal(reg.systemPrompt(off), "");
  });

  test("enabled source contributes when its flag is set", () => {
    const reg = new ToolSourceRegistry();
    reg.register(enabledWhenFlag);
    const on = { availableProviders: new Set(), flags: { on: true } };
    assert.deepEqual(reg.enabled(on).map((s) => s.id), ["gated"]);
    assert.deepEqual(
      reg.tools(on).map((t) => t.function.name),
      ["gated_a"],
    );
  });
});

describe("ToolSourceRegistry routing", () => {
  test("sourceForTool finds the owning enabled source", () => {
    const reg = new ToolSourceRegistry();
    reg.register(source({ id: "x" }));
    reg.register(source({ id: "y" }));
    assert.equal(reg.sourceForTool("y_b", ctx)?.id, "y");
  });

  test("sourceForTool returns undefined for an unknown tool", () => {
    const reg = new ToolSourceRegistry();
    reg.register(source({ id: "x" }));
    assert.equal(reg.sourceForTool("nope", ctx), undefined);
  });

  test("sourceForTool ignores disabled sources", () => {
    const reg = new ToolSourceRegistry();
    reg.register({
      id: "gated",
      tools: [tool("gated_a")],
      isEnabled: () => false,
    });
    assert.equal(reg.sourceForTool("gated_a", ctx), undefined);
  });
});
