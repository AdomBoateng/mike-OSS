"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
    type ApiKeySource,
    type ApiKeyState,
    type ApiKeyProvider,
    type UserProfile as ApiUserProfile,
    getCustomModels,
    getUserProfile,
    isMfaRequiredError,
    saveApiKey,
    saveCustomLlmBaseUrl,
    updateUserMfaOnLogin,
    updateUserProfile,
} from "@/app/lib/mikeApi";
import type { ModelOption } from "@/app/components/assistant/ModelToggle";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string;
    tabularModel: string;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    customLlmBaseUrl: string | null;
    customLlmConfigured: boolean;
    customLlmSource: ApiKeySource;
    apiKeys: ApiKeyState;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    /** Models advertised by the custom endpoint (empty when not configured). */
    customModels: ModelOption[];
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "titleModel" | "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateMfaOnLogin: (enabled: boolean) => Promise<boolean>;
    updateLegalResearchUs: (enabled: boolean) => Promise<boolean>;
    updateApiKey: (
        provider: ApiKeyProvider,
        value: string | null,
    ) => Promise<boolean>;
    updateCustomLlmBaseUrl: (value: string | null) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const API_KEY_PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "openrouter",
    "custom",
    "courtlistener",
];

function emptyApiKeys(): ApiKeyState {
    return {
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        custom: { configured: false, source: null },
        courtlistener: { configured: false, source: null },
    };
}

function toProfile(data: ApiUserProfile): UserProfile {
    const { apiKeyStatus, ...profile } = data;
    const apiKeys = emptyApiKeys();
    for (const provider of API_KEY_PROVIDERS) {
        apiKeys[provider] = {
            configured: !!apiKeyStatus[provider],
            source:
                apiKeyStatus.sources?.[provider] ??
                (apiKeyStatus[provider] ? "user" : null),
        };
    }

    return {
        ...profile,
        mfaOnLogin: profile.mfaOnLogin === true,
        apiKeys,
    };
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [customModels, setCustomModels] = useState<ModelOption[]>([]);
    const [loading, setLoading] = useState(true);
    const userId = user?.id ?? null;

    const loadProfile = useCallback(async () => {
        try {
            const profileData = await getUserProfile();
            setProfile(toProfile(profileData));
        } catch {
            // Calculate a default future reset date for fallback
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);

            // Set fallback profile data on exception
            setProfile({
                displayName: null,
                organisation: null,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999, // temporarily unlimited
                tier: "Free",
                titleModel: "gemini-3.1-flash-lite-preview",
                tabularModel: "gemini-3-flash-preview",
                mfaOnLogin: false,
                legalResearchUs: true,
                customLlmBaseUrl: null,
                customLlmConfigured: false,
                customLlmSource: null,
                apiKeys: emptyApiKeys(),
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && userId) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, userId, loadProfile]);

    const refreshCustomModels = useCallback(async () => {
        try {
            const res = await getCustomModels();
            setCustomModels(
                res.configured
                    ? res.models.map((m) => ({
                          id: m.id,
                          label: m.label,
                          group: "Custom" as const,
                      }))
                    : [],
            );
        } catch {
            // Endpoint unreachable or misconfigured — surface no custom models.
            setCustomModels([]);
        }
    }, []);

    // Refetch the custom model list whenever the endpoint configuration
    // changes (base URL added/removed/edited).
    const customConfigured = profile?.customLlmConfigured ?? false;
    const customBaseUrl = profile?.customLlmBaseUrl ?? null;
    useEffect(() => {
        if (isAuthenticated && customConfigured) {
            void refreshCustomModels();
        } else {
            setCustomModels([]);
        }
    }, [isAuthenticated, customConfigured, customBaseUrl, refreshCustomModels]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }

            try {
                const updated = await updateUserProfile({ displayName });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ organisation });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const updateModelPreference = useCallback(
        async (
            field: "titleModel" | "tabularModel",
            value: string,
        ): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    [field]: value,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateMfaOnLogin = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserMfaOnLogin(enabled);
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const updateLegalResearchUs = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    legalResearchUs: enabled,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateApiKey = useCallback(
        async (
            provider: ApiKeyProvider,
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const normalized = value?.trim() ? value.trim() : null;
            try {
                await saveApiKey(provider, normalized);
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              apiKeys: {
                                  ...prev.apiKeys,
                                  [provider]: {
                                      configured: !!normalized,
                                      source: normalized ? "user" : null,
                                  },
                              },
                          }
                        : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const updateCustomLlmBaseUrl = useCallback(
        async (value: string | null): Promise<boolean> => {
            if (!user) return false;
            const normalized = value?.trim() ? value.trim() : null;
            try {
                const settings = await saveCustomLlmBaseUrl(normalized);
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              customLlmBaseUrl: settings.customLlmBaseUrl,
                              customLlmConfigured: settings.customLlmConfigured,
                              customLlmSource: settings.customLlmSource,
                          }
                        : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (userId) {
            await loadProfile();
        }
    }, [userId, loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!user || !profile) {
            return false;
        }

        // Check if user has credits remaining
        if (profile.creditsRemaining <= 0) {
            return false;
        }

        return false;
    }, [user, profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                customModels,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateMfaOnLogin,
                updateLegalResearchUs,
                updateApiKey,
                updateCustomLlmBaseUrl,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
