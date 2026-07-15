import type { OpenAIToolSchema } from "../llm/types";
import type { ToolSource, ToolSourceContext } from "./types";

/** The tool names a source owns, derived from its tool schemas. */
export function toolNamesOf(source: ToolSource): string[] {
  return source.tools.map((t) => t.function.name);
}

/**
 * Holds the registered ToolSources and assembles what the model sees:
 * the combined tool schemas, the combined system prompt, and the routing from
 * a tool-call name back to the source that owns it.
 *
 * Ordering is registration order, so the assembled tools/prompt are stable.
 */
export class ToolSourceRegistry {
  private readonly sources = new Map<string, ToolSource>();

  /**
   * Register a source. Throws on a duplicate id or a tool-name collision with
   * an already-registered source, so conflicts surface at startup rather than
   * silently shadowing a tool at request time.
   */
  register(source: ToolSource): this {
    if (this.sources.has(source.id)) {
      throw new Error(`ToolSource "${source.id}" is already registered`);
    }
    for (const name of toolNamesOf(source)) {
      const owner = this.ownerOfToolName(name);
      if (owner) {
        throw new Error(
          `Tool "${name}" from source "${source.id}" is already provided by "${owner.id}"`,
        );
      }
    }
    this.sources.set(source.id, source);
    return this;
  }

  /** All registered sources, in registration order. */
  all(): ToolSource[] {
    return [...this.sources.values()];
  }

  /** Sources active for the given context. */
  enabled(ctx: ToolSourceContext): ToolSource[] {
    return this.all().filter((s) => (s.isEnabled ? s.isEnabled(ctx) : true));
  }

  /** OpenAI tool schemas from all enabled sources, in registration order. */
  tools(ctx: ToolSourceContext): OpenAIToolSchema[] {
    return this.enabled(ctx).flatMap((s) => s.tools.map((t) => ({ ...t })));
  }

  /** System-prompt fragments from all enabled sources, joined by blank lines. */
  systemPrompt(ctx: ToolSourceContext): string {
    return this.enabled(ctx)
      .map((s) => s.systemPrompt?.trim())
      .filter((p): p is string => !!p)
      .join("\n\n");
  }

  /** The enabled source that owns `toolName`, if any. */
  sourceForTool(
    toolName: string,
    ctx: ToolSourceContext,
  ): ToolSource | undefined {
    return this.enabled(ctx).find((s) => toolNamesOf(s).includes(toolName));
  }

  /** Any registered source (enabled or not) that owns `name`. */
  private ownerOfToolName(name: string): ToolSource | undefined {
    return this.all().find((s) => toolNamesOf(s).includes(name));
  }
}
