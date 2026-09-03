import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    isCustomModel,
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
    web_search: boolean;
    api_keys: UserApiKeys;
};

/**
 * The model used for the app's own background tasks — chat titles and tabular
 * review — as opposed to the one the user picked for a conversation.
 *
 * This fork serves custom-endpoint models ONLY, so the custom endpoint is the
 * answer whenever it is configured. The cloud branches survive purely for a
 * deployment that still holds one of those keys; nothing in the UI offers
 * those models any more.
 *
 * The endpoint is asked which models it has rather than assuming an id: the
 * list is dynamic and a hard-coded guess breaks the next time the deployment
 * changes. The answer is cached because this is on the profile-read path, and
 * re-listing the endpoint for every profile load would be wasteful.
 *
 * Returns null when nothing is available, which callers treat as "no title
 * model" rather than falling back to a provider the deployment cannot reach.
 */
/**
 * Honour a stored utility-model preference only if the deployment can actually
 * run it.
 *
 * Profiles created before the cutover still hold cloud model ids such as
 * "gemini-3-flash-preview". Passing one straight through means every tabular
 * run or title generation fails on a missing key — the id is *valid*, it is
 * just unreachable here. A custom id is always honoured; a cloud id only when
 * a key for that provider exists.
 */
function usableStoredModel(
    stored: string | null | undefined,
    apiKeys: UserApiKeys,
): string | undefined {
    const id = stored?.trim();
    if (!id) return undefined;
    if (isCustomModel(id)) return id;
    if (id.startsWith("gemini")) return apiKeys.gemini?.trim() ? id : undefined;
    if (id.startsWith("gpt-")) return apiKeys.openai?.trim() ? id : undefined;
    if (id.startsWith("claude")) return apiKeys.claude?.trim() ? id : undefined;
    return undefined;
}

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedUtilityModel: { value: string | null; at: number } | null = null;

export async function resolveUtilityModel(
    apiKeys: UserApiKeys,
): Promise<string | null> {
    const customConfigured =
        !!apiKeys.customBaseUrl?.trim() ||
        !!process.env.CUSTOM_LLM_BASE_URL?.trim();
    if (customConfigured) {
        const fresh =
            cachedUtilityModel &&
            Date.now() - cachedUtilityModel.at < MODEL_CACHE_TTL_MS;
        if (fresh && cachedUtilityModel!.value) return cachedUtilityModel!.value;
        try {
            const models = await listCustomModels(apiKeys);
            if (models.length > 0) {
                const id = toCustomModelId(models[0].name);
                cachedUtilityModel = { value: id, at: Date.now() };
                return id;
            }
        } catch {
            // Endpoint unreachable or listing refused. Fall through; the
            // caller keeps whatever fallback it already had.
        }
    }
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    return null;
}

/** Test seam — clears the memoised custom-model lookup. */
export function resetUtilityModelCache(): void {
    cachedUtilityModel = null;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select(
            "title_model, tabular_model, legal_research_us, legal_research_gh, web_search",
        )
        .eq("user_id", userId)
        .single();
    const api_keys = await getStoredUserApiKeys(userId, client);
    const utilityModel = await resolveUtilityModel(api_keys);

    return {
        title_model: resolveModel(
            usableStoredModel(data?.title_model, api_keys),
            utilityModel ?? "",
        ),
        tabular_model: resolveModel(
            usableStoredModel(data?.tabular_model, api_keys),
            utilityModel ?? "",
        ),
        legal_research_us:
            (data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
        // Absent column (older database, before the Ghana migration) means
        // enabled, matching the column default.
        legal_research_gh:
            (data as { legal_research_gh?: boolean | null } | null)
                ?.legal_research_gh !== false,
        // Absent column (a database predating the web-search migration) means
        // enabled, matching the column default. The real gate is whether a
        // SearXNG instance is configured at all.
        web_search:
            (data as { web_search?: boolean | null } | null)?.web_search !==
            false,
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
