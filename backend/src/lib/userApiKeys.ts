import crypto from "crypto";
import { createServerSupabase } from "./supabase";
import type { UserApiKeys } from "./llm";

type Db = ReturnType<typeof createServerSupabase>;
export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "custom"
    | "courtlistener";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources: Record<ApiKeyProvider, ApiKeySource>;
};

type EncryptedKeyRow = {
    provider: ApiKeyProvider;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
};

const PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "openrouter",
    "custom",
    "courtlistener",
];

function envApiKey(provider: ApiKeyProvider): string | null {
    switch (provider) {
        case "claude":
            return (
                process.env.ANTHROPIC_API_KEY?.trim() ||
                process.env.CLAUDE_API_KEY?.trim() ||
                null
            );
        case "gemini":
            return process.env.GEMINI_API_KEY?.trim() || null;
        case "openai":
            return process.env.OPENAI_API_KEY?.trim() || null;
        case "openrouter":
            return process.env.OPENROUTER_API_KEY?.trim() || null;
        case "custom":
            return process.env.CUSTOM_LLM_API_KEY?.trim() || null;
        case "courtlistener":
            return process.env.COURTLISTENER_API_TOKEN?.trim() || null;
        default:
            return null;
    }
}

export function hasEnvApiKey(provider: ApiKeyProvider): boolean {
    return !!envApiKey(provider);
}

function encryptionKey(): Buffer {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured");
    }
    return crypto.scryptSync(secret, "mike-user-api-keys-v1", 32);
}

function encrypt(value: string): Omit<EncryptedKeyRow, "provider"> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
    };
}

function decrypt(row: EncryptedKeyRow): string | null {
    try {
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            encryptionKey(),
            Buffer.from(row.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(row.encrypted_key, "base64")),
            decipher.final(),
        ]);
        return decrypted.toString("utf8");
    } catch (err) {
        console.error("[user-api-keys] failed to decrypt stored key", {
            provider: row.provider,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

function isProvider(value: string): value is ApiKeyProvider {
    return (PROVIDERS as string[]).includes(value);
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
    return isProvider(value) ? value : null;
}

export async function getUserApiKeyStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const status: ApiKeyStatus = {
        claude: false,
        gemini: false,
        openai: false,
        openrouter: false,
        custom: false,
        courtlistener: false,
        sources: {
            claude: null,
            gemini: null,
            openai: null,
            openrouter: null,
            custom: null,
            courtlistener: null,
        },
    };

    for (const provider of PROVIDERS) {
        if (hasEnvApiKey(provider)) {
            status[provider] = true;
            status.sources[provider] = "env";
        }
    }

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of data ?? []) {
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (provider && !status[provider]) {
            status[provider] = true;
            status.sources[provider] = "user";
        }
    }

    return status;
}

/**
 * Resolve the base URL for the custom OpenAI-compatible endpoint: the user's
 * stored override (user_profiles.custom_llm_base_url) if present, otherwise the
 * CUSTOM_LLM_BASE_URL env fallback. Tolerates databases that predate the column.
 */
export async function getCustomBaseUrl(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<{ url: string | null; source: ApiKeySource }> {
    const envUrl = process.env.CUSTOM_LLM_BASE_URL?.trim() || null;
    const { data, error } = await db
        .from("user_profiles")
        .select("custom_llm_base_url")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        // Older databases may lack the column; fall back to env silently.
        return { url: envUrl, source: envUrl ? "env" : null };
    }
    const userUrl =
        typeof (data as { custom_llm_base_url?: unknown } | null)
            ?.custom_llm_base_url === "string"
            ? ((data as { custom_llm_base_url: string }).custom_llm_base_url.trim() ||
              null)
            : null;
    if (userUrl) return { url: userUrl, source: "user" };
    return { url: envUrl, source: envUrl ? "env" : null };
}

export async function saveCustomBaseUrl(
    userId: string,
    url: string | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    const normalized = url?.trim() || null;
    const { error } = await db
        .from("user_profiles")
        .update({
            custom_llm_base_url: normalized,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (error) throw error;
}

export async function getUserApiKeys(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    const apiKeys: UserApiKeys = {
        claude: envApiKey("claude"),
        gemini: envApiKey("gemini"),
        openai: envApiKey("openai"),
        openrouter: envApiKey("openrouter"),
        custom: envApiKey("custom"),
        courtlistener: envApiKey("courtlistener"),
    };

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of (data ?? []) as EncryptedKeyRow[]) {
        const provider = normalizeApiKeyProvider(row.provider);
        if (!provider) continue;
        if (apiKeys[provider]?.trim()) continue;
        apiKeys[provider] = decrypt(row);
    }

    const { url: customBaseUrl } = await getCustomBaseUrl(userId, db);
    apiKeys.customBaseUrl = customBaseUrl;

    return apiKeys;
}

/**
 * The set of API-key providers with a usable key for a request — either a
 * user-supplied key on `apiKeys` or a configured env fallback. Used to build the
 * ToolSource gating context so key-dependent sources are offered only when a key
 * is present.
 */
export function availableProvidersFrom(
    apiKeys?: UserApiKeys,
): Set<ApiKeyProvider> {
    const providers = new Set<ApiKeyProvider>();
    for (const provider of PROVIDERS) {
        if (apiKeys?.[provider]?.trim() || hasEnvApiKey(provider)) {
            providers.add(provider);
        }
    }
    return providers;
}

export async function saveUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    const normalized = value?.trim() || null;
    if (!normalized) {
        const { error } = await db
            .from("user_api_keys")
            .delete()
            .eq("user_id", userId)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider,
            ...encrypt(normalized),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) throw error;
}
