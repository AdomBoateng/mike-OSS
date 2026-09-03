import type { OpenAIToolSchema } from "../llm/types";
import {
  WEB_SEARCH_TOOLS,
  WEB_SEARCH_SYSTEM_PROMPT,
} from "../legalSourcesTools/webSearchTools";
import { webSearchEnabled } from "../webSearch";
import type { ToolSource } from "./types";

export const WEB_SEARCH_SOURCE_ID = "web-search";

/**
 * Open-web search through a self-hosted SearXNG instance.
 *
 * No `provider`: there is no API key, because there is no third party. The
 * source is gated on an instance actually being configured — with no
 * SEARXNG_BASE_URL the tool is never offered, so a deployment that has not set
 * one up cannot accidentally send a firm's queries anywhere.
 *
 * Also gated on the per-user flag, which is why this is worth stating: unlike
 * the legislation sources, this one sends the user's words outside the
 * building. A firm that would rather it did not can turn it off per account.
 */
export const webSearchSource: ToolSource = {
  id: WEB_SEARCH_SOURCE_ID,
  tools: WEB_SEARCH_TOOLS as unknown as OpenAIToolSchema[],
  systemPrompt: WEB_SEARCH_SYSTEM_PROMPT,
  isEnabled: (ctx) => ctx.flags.includeWebSearch === true && webSearchEnabled(),
};
