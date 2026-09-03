"use client";

import { useCallback, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import { AppSidebar } from "@/app/components/shared/AppSidebar";

export default function MikeLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, authLoading } = useAuth();
    const router = useRouter();
    const [mobileActionsContainer, setMobileActionsContainer] =
        useState<HTMLDivElement | null>(null);

    // Initialize to SSR-safe defaults so the server and client first render
    // match. The real values (saved preference, viewport width) are read after
    // mount in the effect below to avoid a hydration mismatch.
    const [isSidebarOpenDesktop, setIsSidebarOpenDesktop] = useState(true);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);

    useEffect(() => {
        const saved = localStorage.getItem("sidebarOpen");
        setIsSidebarOpenDesktop(saved !== null ? saved === "true" : true);
        if (window.innerWidth < 768) setIsSidebarOpen(false);
    }, []);

    useEffect(() => {
        if (typeof window !== "undefined" && window.innerWidth >= 768) {
            localStorage.setItem("sidebarOpen", isSidebarOpen.toString());
        }
    }, [isSidebarOpenDesktop]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const handleResize = () => {
            const isSmall = window.innerWidth < 768;
            if (isSmall && isSidebarOpen) setIsSidebarOpen(false);
            else if (!isSmall && !isSidebarOpen)
                setIsSidebarOpen(isSidebarOpenDesktop);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, [isSidebarOpen, isSidebarOpenDesktop]);

    const handleSidebarToggle = () => {
        if (window.innerWidth >= 768) {
            setIsSidebarOpenDesktop(!isSidebarOpenDesktop);
            setIsSidebarOpen(!isSidebarOpenDesktop);
        } else {
            setIsSidebarOpen(!isSidebarOpen);
        }
    };

    const handleMobileActionsContainerRef = useCallback(
        (node: HTMLDivElement | null) => {
            setMobileActionsContainer(node);
        },
        [],
    );

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    if (authLoading) {
        return (
            <div className="flex min-h-dvh items-center justify-center bg-gray-50/80">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700" />
            </div>
        );
    }

    if (!isAuthenticated) return null;

    return (
        <ChatHistoryProvider>
            <PageChromeContext.Provider value={{ mobileActionsContainer }}>
                <SidebarContext.Provider
                    value={{
                        setSidebarOpen: (open) => {
                            const isSmall =
                                typeof window !== "undefined" &&
                                window.innerWidth < 768;
                            if (isSmall) {
                                if (!open) setIsSidebarOpen(false);
                                return;
                            }
                            setIsSidebarOpen(open);
                            setIsSidebarOpenDesktop(open);
                        },
                    }}
                >
                    <div className="h-dvh flex flex-col bg-gray-50/80">
                        <div className="flex-1 flex min-w-0 overflow-visible">
                            <AppSidebar
                                isOpen={isSidebarOpen}
                                onToggle={handleSidebarToggle}
                            />
                            <div className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full">
                                {/* Mobile header */}
                                <div className="relative z-20 flex md:hidden items-center gap-3 overflow-visible px-4 pt-3 pb-2 shrink-0">
                                    <button
                                        onClick={handleSidebarToggle}
                                        className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-gray-700 shadow-[0_8px_24px_rgba(15,23,42,0.12)] ring-1 ring-white/70 backdrop-blur-md transition-all hover:bg-white/90 active:scale-95"
                                        title="Open sidebar"
                                        aria-label="Open sidebar"
                                    >
                                        <PanelLeft className="h-4 w-4" />
                                    </button>
                                    <div
                                        ref={handleMobileActionsContainerRef}
                                        className="ml-auto flex min-w-0 flex-1 items-center justify-end"
                                    />
                                </div>
                                <main className="flex h-full w-full flex-1 flex-col overflow-y-auto md:overflow-hidden">
                                    {children}
                                </main>
                            </div>
                        </div>
                    </div>
                </SidebarContext.Provider>
            </PageChromeContext.Provider>
        </ChatHistoryProvider>
    );
}
