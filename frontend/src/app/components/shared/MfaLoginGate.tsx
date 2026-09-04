"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";

// Routes that must render without an MFA step-up (auth flows themselves).
const PUBLIC_PREFIXES = ["/login", "/signup", "/verify-mfa", "/reset-password"];

/**
 * Login-time MFA gate. When a user has enabled "login verification"
 * (profile.mfaOnLogin) and this session has not yet cleared a TOTP challenge
 * (token claim mfaVerified), redirect to /verify-mfa before rendering the app.
 * Users without login-MFA (or already verified) pass straight through; the
 * backend still enforces step-up on individual sensitive actions regardless.
 */
export function MfaLoginGate({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const router = useRouter();
    const pathname = usePathname() || "/";

    const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
    const needsStepUp =
        !!user &&
        user.mfaVerified !== true &&
        (user.mfaLoginRequired === true || profile?.mfaOnLogin === true) &&
        !isPublic;

    useEffect(() => {
        if (!needsStepUp) return;
        router.replace(`/verify-mfa?next=${encodeURIComponent(pathname)}`);
    }, [needsStepUp, pathname, router]);

    if (needsStepUp) {
        return (
            <div className="flex min-h-dvh items-center justify-center bg-gray-50/80">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700" />
            </div>
        );
    }

    return <>{children}</>;
}
