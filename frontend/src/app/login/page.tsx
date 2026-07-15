"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SiteLogo } from "@/components/site-logo";
import { useAuth } from "@/contexts/AuthContext";

const authGlassCardClassName =
    "rounded-2xl border border-white/70 bg-white/72 p-8 shadow-[0_4px_14px_rgba(15,23,42,0.045),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-8px_18px_rgba(255,255,255,0.12)] backdrop-blur-2xl";
const authInputClassName =
    "rounded-lg border border-transparent bg-gray-100 px-3 shadow-none focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45";

export default function LoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading, signIn } = useAuth();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            await signIn(username, password);
            router.push("/assistant");
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "An error occurred during login",
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-dvh bg-gray-50/80 flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={`${authGlassCardClassName} mb-4`}>
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-2xl font-medium font-serif text-gray-950">
                            Log In
                        </h2>
                    </div>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <label
                                htmlFor="username"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Username
                            </label>
                            <Input
                                id="username"
                                type="text"
                                autoComplete="username"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                placeholder="Enter your username"
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="password"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Password
                            </label>
                            <Input
                                id="password"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter your password"
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        {error && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <Button
                            type="submit"
                            disabled={loading}
                            className="w-full mt-5 bg-black hover:bg-gray-900 text-white"
                        >
                            {loading ? "Logging in..." : "Log in"}
                        </Button>
                    </form>
                </div>
            </div>
        </div>
    );
}
