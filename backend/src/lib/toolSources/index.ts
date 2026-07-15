import type { ApiKeyProvider } from "../userApiKeys";
import { ToolSourceRegistry } from "./registry";
import { courtlistenerSource } from "./courtlistenerSource";
import type { ToolSourceContext } from "./types";

export * from "./types";
export { ToolSourceRegistry, toolNamesOf } from "./registry";
export {
  courtlistenerSource,
  COURTLISTENER_SOURCE_ID,
} from "./courtlistenerSource";

/**
 * Process-wide registry of external tool sources. Register additional API
 * sources here as they are added.
 */
export const defaultToolSources = new ToolSourceRegistry();
defaultToolSources.register(courtlistenerSource);

/**
 * Build the gating context used when assembling tools / prompts for a request.
 * `includeResearchTools` mirrors the existing per-user Legal Research > US
 * toggle.
 */
export function buildToolSourceContext(
  includeResearchTools: boolean,
  availableProviders: ReadonlySet<ApiKeyProvider> = new Set(),
): ToolSourceContext {
  return { availableProviders, flags: { includeResearchTools } };
}
