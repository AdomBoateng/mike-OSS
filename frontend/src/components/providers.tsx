"use client";

import { Suspense, useEffect, useState } from "react";
import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { MfaLoginGate } from "@/app/components/shared/MfaLoginGate";

export function Providers({ children }: { children: React.ReactNode }) {
    // The whole app is gated on client-side auth, so the server can only ever
    // render a loading spinner. Render that identical spinner on the server AND
    // the first client render, then swap in the real gate after mount. This
    // keeps hydration deterministic (server and first client render match)
    // instead of the server rendering one loading state and the client another.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    return (
        <AuthProvider>
            <UserProfileProvider>
                <Suspense fallback={<ProviderLoader />}>
                    {mounted ? (
                        <MfaLoginGate>{children}</MfaLoginGate>
                    ) : (
                        <ProviderLoader />
                    )}
                </Suspense>
            </UserProfileProvider>
        </AuthProvider>
    );
}

function ProviderLoader() {
    return (
        <div className="flex min-h-dvh items-center justify-center bg-gray-50/80">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700" />
        </div>
    );
}
