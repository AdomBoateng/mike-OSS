import type { ApiKeyProvider } from "../userApiKeys";
import { ToolSourceRegistry } from "./registry";
import { courtlistenerSource } from "./courtlistenerSource";
import { ghanaLawSource } from "./ghanaLawSource";
import type { ToolSourceContext } from "./types";

export * from "./types";
export { ToolSourceRegistry, toolNamesOf } from "./registry";
export {
  courtlistenerSource,
  COURTLISTENER_SOURCE_ID,
} from "./courtlistenerSource";
export { ghanaLawSource, GHANA_LAW_SOURCE_ID } from "./ghanaLawSource";

/**
 * Process-wide registry of external tool sources. Register additional API
 * sources here as they are added.
 */
export const defaultToolSources = new ToolSourceRegistry();
defaultToolSources.register(courtlistenerSource);
defaultToolSources.register(ghanaLawSource);

/**
 * Per-jurisdiction research toggles. Each source gates on its own flag: they
 * were one boolean while CourtListener was the only source, but a single switch
 * cannot express "Ghana yes, US no", so they are separate.
 *
 * Both default to true, matching the `legal_research_us` column default.
 */
export interface ToolSourceFlags {
  /** Legal Research > US — CourtListener case law. */
  includeResearchTools?: boolean;
  /** Legal Research > Ghana — Parliament of Ghana legislation. */
  includeGhanaLaw?: boolean;
}

/**
 * Build the gating context used when assembling tools / prompts for a request.
 * Accepts a bare boolean for the US flag as a convenience for existing callers.
 */
export function buildToolSourceContext(
  flags: boolean | ToolSourceFlags = {},
  availableProviders: ReadonlySet<ApiKeyProvider> = new Set(),
): ToolSourceContext {
  const f: ToolSourceFlags =
    typeof flags === "boolean" ? { includeResearchTools: flags } : flags;
  return {
    availableProviders,
    flags: {
      includeResearchTools: f.includeResearchTools ?? true,
      includeGhanaLaw: f.includeGhanaLaw ?? true,
    },
  };
}
