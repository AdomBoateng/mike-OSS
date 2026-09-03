import type { OpenAIToolSchema } from "../llm/types";
import {
  GHANA_LAW_TOOLS,
  GHANA_LAW_SYSTEM_PROMPT,
} from "../legalSourcesTools/ghanaLawTools";
import { ghanaLawEnabled } from "../ghanaLaw";
import type { ToolSource } from "./types";

export const GHANA_LAW_SOURCE_ID = "ghana-law";

/**
 * Ghana primary legislation from the Parliament of Ghana repository.
 *
 * No `provider`: the repository API is open, so there is no key to gate on.
 * Gated instead by the per-user Legal Research > Ghana toggle
 * (`includeGhanaLaw`), which defaults on — matching `legal_research_us` — and
 * by GHANA_LAW_ENABLED for switching the source off instance-wide without a
 * deploy (e.g. if the repository is down).
 */
export const ghanaLawSource: ToolSource = {
  id: GHANA_LAW_SOURCE_ID,
  tools: GHANA_LAW_TOOLS as unknown as OpenAIToolSchema[],
  systemPrompt: GHANA_LAW_SYSTEM_PROMPT,
  isEnabled: (ctx) => ctx.flags.includeGhanaLaw === true && ghanaLawEnabled(),
};
