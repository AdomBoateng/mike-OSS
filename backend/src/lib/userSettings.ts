import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    listCustomModels,
    toCustomModelId,
    type UserApiKeys,
} from "./llm";
import { getUserApiKeys as getStoredUserApiKeys } from "./userApiKeys";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    legal_research_us: boolean;
    legal_research_gh: boolean;
    api_keys: UserApiKeys;
};

/**
 * Title generation is a lightweight task, routed to the cheapest model
 * available: a custom endpoint model where one is configured, else the
 * cheapest model of whichever cloud provider the user still has a key for.
 *
 * The custom branch is first because this fork serves custom-endpoint models
 * only. Without it every title generation failed with "Gemini API key is not
 * configured" and silently fell back to a title sliced from the user's own
 * message — working, but never actually model-generated.
 *
 * The endpoint is asked which models it has rather than assuming an id: the
 * custom list is dynamic, and a hard-coded guess would break the moment the
 * deployment changed. A failure here is not fatal — the caller keeps its
 * message-derived fallback — so the lookup stays best-effort.
 */
async function resolveTitleModel(apiKeys: UserApiKeys): Promise<string> {
    const customConfigured =
        !!apiKeys.customBaseUrl?.trim() ||
        !!process.env.CUSTOM_LLM_BASE_URL?.trim();
    if (customConfigured) {
        try {
            const models = await listCustomModels(apiKeys);
            if (models.length > 0) return toCustomModelId(models[0].name);
        } catch {
            // Endpoint unreachable or listing refused: fall through to the
            // cloud providers rather than failing the settings lookup.
        }
    }
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select(
            "title_model, tabular_model, legal_research_us, legal_research_gh",
        )
        .eq("user_id", userId)
        .single();
    const api_keys = await getStoredUserApiKeys(userId, client);

    return {
        title_model: resolveModel(
            data?.title_model,
            await resolveTitleModel(api_keys),
        ),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        legal_research_us:
            (data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
        // Absent column (older database, before the Ghana migration) means
        // enabled, matching the column default.
        legal_research_gh:
            (data as { legal_research_gh?: boolean | null } | null)
                ?.legal_research_gh !== false,
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    return getStoredUserApiKeys(userId, client);
}
