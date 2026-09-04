"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    ReactNode,
} from "react";
import { clearStoredToken } from "@/lib/authToken";
import {
    getSession,
    login as apiLogin,
    logout as apiLogout,
    type SessionUser,
} from "@/app/lib/mikeApi";

interface User {
    id: string;
    email: string;
    pendingEmail?: string | null;
    /** Whether this session has cleared a TOTP step-up (from the token claim). */
    mfaVerified: boolean;
    /** Whether TOTP is required before ordinary API access for this login. */
    mfaLoginRequired: boolean;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signIn: (username: string, password: string) => Promise<void>;
    signOut: () => Promise<void>;
    updateEmail: (email: string) => Promise<User>;
    /** Apply session state returned after an MFA cookie rotation. */
    applySessionUser: (user: SessionUser) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function userFromSession(sessionUser: SessionUser): User {
    return {
        id: sessionUser.id,
        email: sessionUser.email ?? "",
        pendingEmail: null,
        mfaVerified: sessionUser.mfaVerified === true,
        mfaLoginRequired: sessionUser.mfaLoginRequired === true,
    };
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    useEffect(() => {
        let active = true;
        async function restoreSession() {
            try {
                const result = await getSession();
                if (active) setUser(userFromSession(result.user));
            } catch {
                clearStoredToken();
                if (active) setUser(null);
            } finally {
                if (active) setAuthLoading(false);
            }
        }
        void restoreSession();
        return () => {
            active = false;
        };
    }, []);

    const signIn = useCallback(async (username: string, password: string) => {
        const result = await apiLogin(username, password);
        clearStoredToken();
        setUser(userFromSession(result.user));
    }, []);

    const signOut = useCallback(async () => {
        try {
            await apiLogout();
        } finally {
            clearStoredToken();
            setUser(null);
        }
    }, []);

    // Email comes from the LDAP directory; it is not editable in-app.
    const updateEmail = useCallback(async (): Promise<User> => {
        throw new Error("Email is managed by your directory administrator.");
    }, []);

    const applySessionUser = useCallback((sessionUser: SessionUser) => {
        clearStoredToken();
        setUser(userFromSession(sessionUser));
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
                applySessionUser,
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
