"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    ReactNode,
} from "react";
import {
    getStoredToken,
    setStoredToken,
    clearStoredToken,
} from "@/lib/authToken";
import { login as apiLogin } from "@/app/lib/mikeApi";

interface User {
    id: string;
    email: string;
    pendingEmail?: string | null;
    /** Whether this session has cleared a TOTP step-up (from the token claim). */
    mfaVerified: boolean;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signIn: (username: string, password: string) => Promise<void>;
    signOut: () => Promise<void>;
    updateEmail: (email: string) => Promise<User>;
    /** Replace the active session token (e.g. after an MFA step-up re-issues it). */
    applySessionToken: (token: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface TokenClaims {
    sub: string;
    email?: string;
    exp?: number;
    mfaVerified?: boolean;
}

function decodeToken(token: string): TokenClaims | null {
    try {
        const part = token.split(".")[1];
        if (!part) return null;
        const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
        return JSON.parse(json) as TokenClaims;
    } catch {
        return null;
    }
}

function userFromToken(token: string): User | null {
    const claims = decodeToken(token);
    if (!claims?.sub) return null;
    if (claims.exp && claims.exp * 1000 <= Date.now()) return null; // expired
    return {
        id: claims.sub,
        email: claims.email ?? "",
        pendingEmail: null,
        mfaVerified: claims.mfaVerified === true,
    };
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    useEffect(() => {
        const token = getStoredToken();
        if (token) {
            const restored = userFromToken(token);
            if (restored) setUser(restored);
            else clearStoredToken();
        }
        setAuthLoading(false);
    }, []);

    const signIn = useCallback(async (username: string, password: string) => {
        const result = await apiLogin(username, password);
        setStoredToken(result.token);
        setUser(
            userFromToken(result.token) ?? {
                id: result.user.id,
                email: result.user.email ?? "",
                pendingEmail: null,
                mfaVerified: false,
            },
        );
    }, []);

    const signOut = useCallback(async () => {
        clearStoredToken();
        setUser(null);
    }, []);

    // Email comes from the LDAP directory; it is not editable in-app.
    const updateEmail = useCallback(async (): Promise<User> => {
        throw new Error("Email is managed by your directory administrator.");
    }, []);

    const applySessionToken = useCallback((token: string) => {
        setStoredToken(token);
        const next = userFromToken(token);
        if (next) setUser(next);
    }, []);

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading,
                signIn,
                signOut,
                updateEmail,
                applySessionToken,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
