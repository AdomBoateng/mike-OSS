import type { OpenAIToolSchema } from "../llm/types";
import type { ApiKeyProvider } from "../userApiKeys";

/**
 * Context passed to a ToolSource's gating check so it can decide whether it
 * should be offered to the model for the current request.
 */
export interface ToolSourceContext {
  /**
   * API-key providers that have a usable key (user-supplied or env) for this
   * request. A source MAY gate on this, but most do not — e.g. CourtListener
   * works without a token, just at a lower rate limit.
   */
  availableProviders: ReadonlySet<ApiKeyProvider>;
  /**
   * Feature flags / user preferences a source may gate on, e.g.
   * `{ legalResearchUs: true }`.
   */
  flags: Readonly<Record<string, boolean>>;
}

/**
 * A pluggable external-data / tool provider. CourtListener is the first one;
 * additional APIs register as further sources.
 *
 * A source contributes OpenAI-style tool schemas plus a system-prompt fragment
 * and (implicitly, via its tool names) declares which tool calls it owns, so
 * the registry can assemble what the model sees and route calls back to the
 * right source.
 */
export interface ToolSource {
  /** Stable identifier, e.g. "courtlistener". Must be unique per registry. */
  readonly id: string;
  /** API-key provider this source uses, if any (see userApiKeys). */
  readonly provider?: ApiKeyProvider;
  /** OpenAI-style tool schemas contributed to the model. */
  readonly tools: readonly OpenAIToolSchema[];
  /** Fragment appended to the system prompt when this source is enabled. */
  readonly systemPrompt?: string;
  /**
   * Whether this source is active for the current request. When omitted the
   * source is always enabled. Disabled sources contribute no tools/prompt and
   * own no tool names for routing.
   */
  isEnabled?(ctx: ToolSourceContext): boolean;
}
