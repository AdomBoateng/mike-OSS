import {
    SETTINGS_MODELS,
    isCustomModelId,
    type ModelOption,
} from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "@/app/lib/mikeApi";

export type ModelProvider = "claude" | "gemini" | "openai" | "custom";

export function getModelProvider(modelId: string): ModelProvider | null {
    if (isCustomModelId(modelId)) return "custom";
    const model = SETTINGS_MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    return modelGroupToProvider(model.group);
}

/**
 * @param customConfigured whether a custom endpoint base URL is configured;
 *   custom models are gated on the endpoint, not on an API key.
 */
export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
    customConfigured = false,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    if (provider === "custom") return customConfigured;
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    if (provider === "custom") return !!apiKeys.custom?.configured;
    return !!apiKeys[provider]?.configured;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI";
    if (provider === "custom") return "Custom endpoint";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    if (group === "Custom") return "custom";
    return "gemini";
}
