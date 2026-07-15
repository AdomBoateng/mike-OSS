"use client";

// TEMPORARY reproduction harness for the "Maximum update depth exceeded" loop.
// Renders the real ChatView + useAssistantChat outside the auth layout and
// feeds handleChat a mocked SSE stream that bursts many reasoning_delta events.
// Delete this route once the bug is fixed.

import { useEffect, useRef, useState } from "react";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { ChatView } from "@/app/components/assistant/ChatView";

function makeSseStream(mode: "one-chunk" | "many-chunks") {
    const enc = new TextEncoder();
    const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            controller.enqueue(enc.encode(ev({ type: "chat_id", chatId: "test-chat" })));
            const deltas = Array.from({ length: 300 }, (_, i) =>
                ev({ type: "reasoning_delta", text: `token${i} ` }),
            );
            if (mode === "one-chunk") {
                // One network read delivering a big burst of events.
                controller.enqueue(enc.encode(deltas.join("")));
            } else {
                for (const d of deltas) {
                    controller.enqueue(enc.encode(d));
                    // yield to the event loop between reads
                    await new Promise((r) => setTimeout(r, 0));
                }
            }
            controller.enqueue(enc.encode(ev({ type: "reasoning_block_end" })));
            controller.enqueue(enc.encode(ev({ type: "content_delta", text: "Done." })));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
}

function LoopTestInner({ mode }: { mode: "one-chunk" | "many-chunks" }) {
    const { messages, isResponseLoading, handleChat, cancel, chatId } =
        useAssistantChat();
    const started = useRef(false);

    useEffect(() => {
        const originalFetch = window.fetch;
        window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            const method = (init?.method ?? "GET").toUpperCase();
            if (url.includes("/chat") && method === "POST") {
                return new Response(makeSseStream(mode), {
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                });
            }
            // Everything else (auth token, chat list, etc.) → benign.
            return new Response("[]", {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof window.fetch;
        return () => {
            window.fetch = originalFetch;
        };
    }, [mode]);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void handleChat({ role: "user", content: "reproduce the loop" });
    }, [handleChat]);

    return (
        <ChatView
            chatId={chatId}
            messages={messages}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
        />
    );
}

export default function LoopTestPage() {
    const [mode, setMode] = useState<"one-chunk" | "many-chunks" | null>(null);
    return (
        <div style={{ height: "100dvh" }}>
            {mode === null ? (
                <div style={{ padding: 24, display: "flex", gap: 12 }}>
                    <button onClick={() => setMode("one-chunk")}>
                        Run one-chunk burst
                    </button>
                    <button onClick={() => setMode("many-chunks")}>
                        Run many-chunks
                    </button>
                </div>
            ) : (
                <ChatHistoryProvider>
                    <LoopTestInner mode={mode} />
                </ChatHistoryProvider>
            )}
        </div>
    );
}
