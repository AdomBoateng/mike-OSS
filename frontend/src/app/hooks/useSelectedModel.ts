"use client";

import { useCallback, useEffect, useState } from "react";
import {
    ALLOWED_MODEL_IDS,
    DEFAULT_MODEL_ID,
    isCustomModelId,
} from "../components/assistant/ModelToggle";

const STORAGE_KEY = "mike.selectedModel";

// Custom endpoint model ids are dynamic, so they can't be in the static
// allow-list; accept them by their `custom/` namespace instead.
function isAllowedModelId(id: string): boolean {
    return ALLOWED_MODEL_IDS.has(id) || isCustomModelId(id);
}

function readStored(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && isAllowedModelId(raw)) return raw;
    return DEFAULT_MODEL_ID;
}

/**
 * The raw persisted model id (or null). Unlike the hook's `model`, this is
 * readable synchronously before the hook hydrates on mount — used to avoid
 * clobbering a valid saved selection during that first-render window.
 */
export function getStoredModelId(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(STORAGE_KEY);
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(DEFAULT_MODEL_ID);

    useEffect(() => {
        setModelState(readStored());
    }, []);

    const setModel = useCallback((id: string) => {
        const next = isAllowedModelId(id) ? id : DEFAULT_MODEL_ID;
        setModelState(next);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    return [model, setModel];
}
