import type { OpenAIToolSchema } from "../llm/types";
import {
  COURTLISTENER_TOOLS,
  COURTLISTENER_SYSTEM_PROMPT,
} from "../legalSourcesTools/courtlistenerTools";
import type { ToolSource } from "./types";

export const COURTLISTENER_SOURCE_ID = "courtlistener";

/**
 * CourtListener (US case-law) as the first ToolSource. Wraps the existing
 * COURTLISTENER_TOOLS / prompt so tool-schema and system-prompt assembly can be
 * driven by the registry. Gated per-user by the Legal Research > US toggle,
 * surfaced here as the `includeResearchTools` flag (matching the previous
 * hardcoded behavior in chatTools.ts).
 *
 * NOTE: dispatch for these tools still lives inline in chatTools.ts; only
 * discovery/prompting is registry-driven for now.
 */
export const courtlistenerSource: ToolSource = {
  id: COURTLISTENER_SOURCE_ID,
  provider: "courtlistener",
  tools: COURTLISTENER_TOOLS as OpenAIToolSchema[],
  systemPrompt: COURTLISTENER_SYSTEM_PROMPT,
  isEnabled: (ctx) => ctx.flags.includeResearchTools === true,
};
