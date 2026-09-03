"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  streamChat,
  streamProjectChat,
} from "@/app/lib/mikeApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useGenerateChatTitle } from "./useGenerateChatTitle";
import type {
  AssistantEvent,
  CitationAnnotation,
  Message,
} from "@/app/components/shared/types";

interface UseAssistantChatOptions {
  initialMessages?: Message[];
  chatId?: string;
  projectId?: string;
}

function readableStreamError(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return "Sorry, something went wrong.";
}

function parseCourtlistenerEventCases(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      return {
        cluster_id:
          typeof row.cluster_id === "number" ? row.cluster_id : 0,
        case_name:
          typeof row.case_name === "string" ? row.case_name : null,
        citation:
          typeof row.citation === "string" ? row.citation : null,
        dateFiled:
          typeof row.dateFiled === "string" ? row.dateFiled : null,
        url: typeof row.url === "string" ? row.url : null,
      };
    })
    .filter(
      (item): item is NonNullable<typeof item> =>
        !!item && item.cluster_id > 0,
    );
}

function parseCourtlistenerCaseSearches(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      return {
        cluster_id:
          typeof row.cluster_id === "number" ? row.cluster_id : null,
        query: typeof row.query === "string" ? row.query : "",
        total_matches:
          typeof row.total_matches === "number" ? row.total_matches : 0,
        case_name:
          typeof row.case_name === "string" ? row.case_name : null,
        citation:
          typeof row.citation === "string" ? row.citation : null,
        error: typeof row.error === "string" ? row.error : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
}

import {
  abortStream,
  clearStream,
  endStream,
  getStreamEvents,
  isStreaming,
  publishStreamEvents,
  startStream,
  subscribeToStream,
} from "./activeStreams";

export function useAssistantChat({
  initialMessages = [],
  chatId: initialChatId,
  projectId,
}: UseAssistantChatOptions = {}) {
  const router = useRouter();
  const {
    replaceChatId,
    loadChats,
    setCurrentChatId,
    saveChat,
    setNewChatMessages,
  } = useChatHistoryContext();
  const { generate: generateTitle } = useGenerateChatTitle();

  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isResponseLoading, setIsResponseLoading] = useState(false);
  const [isLoadingCitations, setIsLoadingCitations] = useState(false);
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);

  const abortControllerRef = useRef<AbortController | null>(null);
  /**
   * The chat this instance is streaming into. A ref, not the state value: the
   * publishing below runs from the streaming loop, which after an unmount is
   * closed over whatever `chatId` was at its last render.
   */
  const streamingChatIdRef = useRef<string | null>(null);
  /** True once this instance has claimed the stream for the current chat. */
  const ownsCurrentStream =
    !!chatId && streamingChatIdRef.current === chatId;

  const eventsRef = useRef<AssistantEvent[]>([]);

  // Streaming deltas (content/reasoning tokens) can arrive far faster than
  // React can commit — a reasoning model emits hundreds per turn. Mirroring the
  // event buffer into message state on every single delta floods React with
  // synchronous commits and, together with effects that re-run on each
  // `messages` change, can trip its "Maximum update depth exceeded" guard.
  // Coalesce those high-frequency updates to at most one per animation frame;
  // structural events (tool calls, doc events, errors, completion) still flush
  // immediately via their own setMessages.
  const flushRafRef = useRef<number | null>(null);

  const writeEventsToLastAssistant = () => {
    const snapshot = [...eventsRef.current];
    // Mirror to the registry from here rather than from an effect. This runs
    // inside the streaming loop, so it keeps publishing after this page is
    // unmounted — which is exactly when another page needs to read it.
    if (streamingChatIdRef.current) {
      publishStreamEvents(streamingChatIdRef.current, snapshot);
    }
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === "assistant") {
        updated[updated.length - 1] = { ...last, events: snapshot };
      }
      return updated;
    });
  };

  const scheduleEventsFlush = () => {
    if (flushRafRef.current != null) return;
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = null;
      writeEventsToLastAssistant();
    });
  };

  // Cancel any pending coalesced flush and mirror the buffer immediately, so a
  // terminal state (finalize, cancel, error) commits synchronously rather than
  // waiting on — or being clobbered by — a queued frame.
  const flushEventsToMessages = () => {
    if (flushRafRef.current != null) {
      cancelAnimationFrame(flushRafRef.current);
      flushRafRef.current = null;
    }
    writeEventsToLastAssistant();
  };

  /**
   * Finalize any in-flight streaming content event so the next
   * content_delta starts a fresh block. Called
   * before any non-content event is appended, so interleaved content /
   * reasoning / tool events stay in chronological order — without the
   * later content block inheriting the earlier block's accumulated text.
   */
  const finalizeStreamingContent = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last?.type === "content" && last.isStreaming) {
      eventsRef.current = [
        ...events.slice(0, -1),
        { type: "content", text: last.text },
      ];
      const snapshot = [...eventsRef.current];
      setMessages((prev) => {
        const updated = [...prev];
        const lastMsg = updated[updated.length - 1];
        if (lastMsg?.role === "assistant") {
          updated[updated.length - 1] = {
            ...lastMsg,
            events: snapshot,
          };
        }
        return updated;
      });
    }
  };

  // If the model transitions from reasoning into content/tool without a
  // reasoning_block_end (or the events arrive out of order), the prior
  // reasoning event would otherwise stay flagged isStreaming forever.
  const finalizeStreamingReasoning = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last?.type !== "reasoning" || !last.isStreaming) return;
    eventsRef.current = [
      ...events.slice(0, -1),
      { type: "reasoning", text: last.text },
    ];
    const snapshot = [...eventsRef.current];
    setMessages((prev) => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg?.role === "assistant") {
        updated[updated.length - 1] = {
          ...lastMsg,
          events: snapshot,
        };
      }
      return updated;
    });
  };

  // Transient placeholder events (tool_call_start, thinking) fill the
  // latency gap between real SSE events so the wrapper doesn't look stuck.
  // Anytime a real event arrives, drop any streaming placeholder first.
  const isStreamingPlaceholder = (e: AssistantEvent) =>
    (e.type === "tool_call_start" || e.type === "thinking") && !!e.isStreaming;

  const cancelStreamingEvents = (events: AssistantEvent[]) =>
    events
      .filter((event) => !isStreamingPlaceholder(event))
      .map((event) => {
        if (!("isStreaming" in event) || !event.isStreaming) return event;
        const rest = { ...event };
        delete (rest as { isStreaming?: boolean }).isStreaming;
        return rest as AssistantEvent;
      });

  const appendCancellationEvent = (events: AssistantEvent[]) => {
    const cancelledEvents = cancelStreamingEvents(events);
    return [
      ...cancelledEvents,
      { type: "content" as const, text: "Cancelled by user." },
    ];
  };

  const cancel = () => {
    if (!abortControllerRef.current && chatId && isStreaming(chatId)) {
      // Adopted stream: the controller belongs to the (unmounted) page that
      // started it, so route the stop through the registry rather than
      // silently doing nothing.
      abortStream(chatId);
      return;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      if (flushRafRef.current != null) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
      }
      const snapshot = cancelStreamingEvents(eventsRef.current);
      eventsRef.current = snapshot;
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            events: cancelStreamingEvents(last.events ?? snapshot),
          };
        }
        return updated;
      });
      setIsResponseLoading(false);
      setIsLoadingCitations(false);
    }
  };

  const clearStreamingPlaceholders = () => {
    const before = eventsRef.current;
    const after = before.filter((e) => !isStreamingPlaceholder(e));
    if (after.length === before.length) return;
    eventsRef.current = after;
    const snapshot = [...after];
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === "assistant") {
        updated[updated.length - 1] = { ...last, events: snapshot };
      }
      return updated;
    });
  };

  const pushThinkingPlaceholder = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    // Don't stack placeholders back-to-back; one "Thinking…" line is plenty.
    if (last && isStreamingPlaceholder(last)) return;
    eventsRef.current = [
      ...events,
      { type: "thinking" as const, isStreaming: true },
    ];
    const snapshot = [...eventsRef.current];
    setMessages((prev) => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg?.role === "assistant") {
        updated[updated.length - 1] = { ...lastMsg, events: snapshot };
      }
      return updated;
    });
  };

  const pushEvent = (event: AssistantEvent) => {
    finalizeStreamingContent();
    finalizeStreamingReasoning();
    // A real event, or a more specific placeholder such as
    // tool_call_start, should replace any generic "Thinking..." line.
    const next = eventsRef.current.filter((e) => !isStreamingPlaceholder(e));
    eventsRef.current = [...next, event];
    const snapshot = [...eventsRef.current];
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === "assistant") {
        updated[updated.length - 1] = { ...last, events: snapshot };
      }
      return updated;
    });
  };

  const updateMatchingEvent = (
    predicate: (e: AssistantEvent) => boolean,
    updater: (e: AssistantEvent) => AssistantEvent,
  ) => {
    const events = eventsRef.current;
    const idx = [...events]
      .map((_, i) => i)
      .reverse()
      .find((i) => predicate(events[i]));
    if (idx === undefined) return false;
    const newEvents = [...events];
    newEvents[idx] = updater(events[idx]);
    eventsRef.current = newEvents;
    const snapshot = [...newEvents];
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === "assistant") {
        updated[updated.length - 1] = { ...last, events: snapshot };
      }
      return updated;
    });
    return true;
  };

  const handleChat = async (
    message: Message,
    opts?: {
      displayedDoc?: { filename: string; documentId: string } | null;
    },
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;

    // Register immediately for an existing chat; a brand-new one registers when
    // its id arrives in the first SSE frame.
    if (chatId) {
      clearStream(chatId);
      streamingChatIdRef.current = chatId;
      startStream(chatId, () => abortControllerRef.current?.abort());
    }
    setIsResponseLoading(true);

    const lastMessage = messages[messages.length - 1];
    const isMessageAlreadyAdded =
      lastMessage &&
      lastMessage.role === "user" &&
      lastMessage.content === message.content;

    const newMessages: Message[] = isMessageAlreadyAdded
      ? messages
      : [...messages, message];

    setMessages([
      ...newMessages,
      { role: "assistant", content: "", annotations: [], events: [] },
    ]);

    let streamedChatId: string | null = null;

    eventsRef.current = [];

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const apiMessages = newMessages.map((currentMessage) => ({
        role: currentMessage.role,
        content: currentMessage.content,
        files: currentMessage.files,
        workflow: currentMessage.workflow,
      }));

      const model = message.model;

      const displayedDoc = opts?.displayedDoc ?? null;

      // Pull the user's attachments from the just-submitted message.
      // These are the files dragged into / picked from the chat input
      // for this turn (separate from the running history of past
      // attachments). Sent as a request-level field so the backend
      // can call them out specifically in the system prompt.
      const attachedDocs = (
        message.files?.filter((f) => !!f.document_id) ?? []
      ).map((f) => ({
        filename: f.filename,
        document_id: f.document_id as string,
      }));

      const response = await (projectId
        ? streamProjectChat({
            projectId,
            messages: apiMessages,
            chat_id: chatId,
            model,
            displayed_doc: displayedDoc
              ? {
                  filename: displayedDoc.filename,
                  document_id: displayedDoc.documentId,
                }
              : undefined,
            attached_documents:
              attachedDocs.length > 0 ? attachedDocs : undefined,
            signal: controller.signal,
          })
        : streamChat({
            messages: apiMessages,
            chat_id: chatId,
            model,
            signal: controller.signal,
          }));

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") continue;

          try {
            const data = JSON.parse(dataStr);

            if (data.type === "chat_id") {
              streamedChatId = data.chatId;
              if (streamingChatIdRef.current !== data.chatId) {
                streamingChatIdRef.current = data.chatId;
                startStream(data.chatId, () =>
                  abortControllerRef.current?.abort(),
                );
              }
              setChatId(data.chatId);
              setCurrentChatId(data.chatId);
              continue;
            }

            if (data.type === "content_done") {
              setIsLoadingCitations(true);
              continue;
            }

            if (data.type === "error") {
              const message = readableStreamError(data.message);
              clearStreamingPlaceholders();
              finalizeStreamingContent();
              finalizeStreamingReasoning();
              eventsRef.current = [
                ...eventsRef.current,
                { type: "error", message },
              ];
              const snapshot = [...eventsRef.current];
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    events: snapshot,
                    error: message,
                  };
                }
                return updated;
              });
              setIsResponseLoading(false);
              setIsLoadingCitations(false);
              continue;
            }

            if (data.type === "content_delta") {
              const text = data.text as string;

              // Real content is streaming — retire any
              // "Thinking…" / "Running…" placeholders, and
              // finalize any in-flight reasoning block so it
              // doesn't get stuck rendering as streaming.
              clearStreamingPlaceholders();
              finalizeStreamingReasoning();

              // Ensure a streaming content event exists. If
              // the last event isn't already a streaming
              // content block, start a fresh one so interleaved
              // tool/reasoning events split content naturally.
              const events = eventsRef.current;
              const lastEvent = events[events.length - 1];
              if (lastEvent?.type !== "content" || !lastEvent.isStreaming) {
                eventsRef.current = [
                  ...events,
                  {
                    type: "content" as const,
                    text,
                    isStreaming: true,
                  },
                ];
                scheduleEventsFlush();
              } else {
                const nextEvents = [...events];
                nextEvents[nextEvents.length - 1] = {
                  type: "content" as const,
                  text: `${lastEvent.text}${text}`,
                  isStreaming: true,
                };
                eventsRef.current = nextEvents;
                scheduleEventsFlush();
              }
              continue;
            }

            if (data.type === "reasoning_delta") {
              const text = data.text as string;
              let events = eventsRef.current;
              const last = events[events.length - 1];
              if (last?.type === "reasoning" && last.isStreaming) {
                eventsRef.current = [
                  ...events.slice(0, -1),
                  {
                    type: "reasoning" as const,
                    text: last.text + text,
                    isStreaming: true,
                  },
                ];
              } else {
                // New reasoning block — finalize any in-flight
                // content event first so the next content_delta
                // starts a fresh block at the correct position.
                finalizeStreamingContent();
                clearStreamingPlaceholders();
                events = eventsRef.current;
                eventsRef.current = [
                  ...events,
                  {
                    type: "reasoning" as const,
                    text,
                    isStreaming: true,
                  },
                ];
              }
              scheduleEventsFlush();
              continue;
            }

            if (data.type === "reasoning_block_end") {
              const events = eventsRef.current;
              const last = events[events.length - 1];
              if (last?.type === "reasoning" && last.isStreaming) {
                eventsRef.current = [
                  ...events.slice(0, -1),
                  {
                    type: "reasoning" as const,
                    text: last.text,
                  },
                ];
              }
              const snapshot = [...eventsRef.current];
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    events: snapshot,
                  };
                }
                return updated;
              });
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "tool_call_start") {
              // Transient placeholder so the client immediately
              // shows activity after Claude ends a turn with
              // tool_use. Replaced by the real tool event
              // (doc_edited_start, doc_read_start, …) if one
              // arrives; otherwise it lingers as a "Working…"
              // indicator until the next iteration streams.
              pushEvent({
                type: "tool_call_start",
                name: (data.name as string) ?? "",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "workflow_applied") {
              pushEvent({
                type: "workflow_applied",
                workflow_id: data.workflow_id as string,
                title: data.title as string,
              });
              continue;
            }

            if (data.type === "case_citation") {
              pushEvent({
                type: "case_citation",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                case_name:
                  typeof data.case_name === "string"
                    ? (data.case_name as string)
                    : null,
                citation:
                  typeof data.citation === "string"
                    ? (data.citation as string)
                    : null,
                url: data.url as string,
                pdfUrl:
                  typeof data.pdfUrl === "string" ? (data.pdfUrl as string) : null,
                dateFiled:
                  typeof data.dateFiled === "string"
                    ? (data.dateFiled as string)
                    : null,
              });
              continue;
            }

            if (data.type === "case_opinions") {
              pushEvent({
                type: "case_opinions",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : 0,
                case: data.case as Extract<
                  AssistantEvent,
                  { type: "case_opinions" }
                >["case"],
              });
              continue;
            }

            if (data.type === "mcp_tool_start") {
              pushEvent({
                type: "mcp_tool_call",
                connector_id: "",
                connector_name: "",
                tool_name: (data.name as string) ?? "",
                openai_tool_name: (data.name as string) ?? "",
                status: "ok",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "mcp_tool_result") {
              const openaiToolName = (data.name as string) ?? "";
              updateMatchingEvent(
                (e) =>
                  e.type === "mcp_tool_call" &&
                  e.openai_tool_name === openaiToolName &&
                  !!e.isStreaming,
                () => ({
                  type: "mcp_tool_call",
                  connector_id: "",
                  connector_name:
                    typeof data.connector_name === "string"
                      ? (data.connector_name as string)
                      : "",
                  tool_name:
                    typeof data.tool_name === "string"
                      ? (data.tool_name as string)
                      : openaiToolName,
                  openai_tool_name: openaiToolName,
                  status: data.status === "error" ? "error" : "ok",
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_search_case_law_start") {
              pushEvent({
                type: "courtlistener_search_case_law",
                query: (data.query as string) ?? "",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_search_case_law") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_search_case_law" &&
                  e.query === (data.query as string) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_search_case_law",
                  query: (data.query as string) ?? "",
                  result_count:
                    typeof data.result_count === "number"
                      ? (data.result_count as number)
                      : 0,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_get_cases_start") {
              pushEvent({
                type: "courtlistener_get_cases",
                cluster_ids: Array.isArray(data.cluster_ids)
                  ? (data.cluster_ids as unknown[]).filter(
                      (value: unknown): value is number =>
                        typeof value === "number",
                    )
                  : [],
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_get_cases") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_get_cases" &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_get_cases",
                  cluster_ids: Array.isArray(data.cluster_ids)
                    ? (data.cluster_ids as unknown[]).filter(
                        (value: unknown): value is number =>
                          typeof value === "number",
                      )
                    : [],
                  case_count:
                    typeof data.case_count === "number"
                      ? (data.case_count as number)
                      : 0,
                  opinion_count:
                    typeof data.opinion_count === "number"
                      ? (data.opinion_count as number)
                      : 0,
                  cases: parseCourtlistenerEventCases(data.cases),
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_find_in_case_start") {
              const searches = parseCourtlistenerCaseSearches(data.searches);
              pushEvent({
                type: "courtlistener_find_in_case",
                cluster_id: searches?.length
                  ? null
                  : typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                query: searches?.length ? "" : ((data.query as string) ?? ""),
                searches,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_find_in_case") {
              const searches = parseCourtlistenerCaseSearches(data.searches);
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_find_in_case" &&
                  (searches?.length
                    ? Array.isArray(e.searches)
                    : e.cluster_id ===
                        (typeof data.cluster_id === "number"
                          ? (data.cluster_id as number)
                          : null) && e.query === (data.query as string)) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_find_in_case",
                  cluster_id: searches?.length
                    ? null
                    : typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null,
                  query: searches?.length ? "" : ((data.query as string) ?? ""),
                  total_matches:
                    typeof data.total_matches === "number"
                      ? (data.total_matches as number)
                      : 0,
                  searches,
                  case_name:
                    typeof data.case_name === "string"
                      ? (data.case_name as string)
                      : null,
                  citation:
                    typeof data.citation === "string"
                      ? (data.citation as string)
                      : null,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_read_case_start") {
              pushEvent({
                type: "courtlistener_read_case",
                cluster_id:
                  typeof data.cluster_id === "number"
                    ? (data.cluster_id as number)
                    : null,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_read_case") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_read_case" &&
                  e.cluster_id ===
                    (typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null) &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_read_case",
                  cluster_id:
                    typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null,
                  case_name:
                    typeof data.case_name === "string"
                      ? (data.case_name as string)
                      : null,
                  citation:
                    typeof data.citation === "string"
                      ? (data.citation as string)
                      : null,
                  opinion_count:
                    typeof data.opinion_count === "number"
                      ? (data.opinion_count as number)
                      : 0,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "courtlistener_verify_citations_start") {
              pushEvent({
                type: "courtlistener_verify_citations",
                citation_count:
                  typeof data.citation_count === "number"
                    ? (data.citation_count as number)
                    : 0,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "courtlistener_verify_citations") {
              updateMatchingEvent(
                (e) =>
                  e.type === "courtlistener_verify_citations" &&
                  !!e.isStreaming,
                () => ({
                  type: "courtlistener_verify_citations",
                  citation_count:
                    typeof data.citation_count === "number"
                      ? (data.citation_count as number)
                      : 0,
                  match_count:
                    typeof data.match_count === "number"
                      ? (data.match_count as number)
                      : 0,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_read_start") {
              pushEvent({
                type: "doc_read",
                filename: data.filename as string,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_read") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_read" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                (e) => ({ ...e, isStreaming: false }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_find_start") {
              pushEvent({
                type: "doc_find",
                filename: data.filename as string,
                query: (data.query as string) ?? "",
                total_matches: 0,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_find") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_find" &&
                  e.filename === data.filename &&
                  e.query === (data.query as string) &&
                  !!e.isStreaming,
                (e) => ({
                  ...e,
                  isStreaming: false,
                  total_matches:
                    typeof data.total_matches === "number"
                      ? (data.total_matches as number)
                      : (
                          e as {
                            type: "doc_find";
                            total_matches: number;
                          }
                        ).total_matches,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_created_start") {
              pushEvent({
                type: "doc_created",
                filename: data.filename as string,
                download_url: "",
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_download") {
              pushEvent({
                type: "doc_download",
                filename: data.filename as string,
                download_url: data.download_url as string,
              });
              continue;
            }

            if (data.type === "doc_created") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_created" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                (e) => {
                  const next: Extract<AssistantEvent, { type: "doc_created" }> =
                    {
                      type: "doc_created",
                      filename: (e as { filename: string }).filename,
                      download_url: data.download_url as string,
                      isStreaming: false,
                    };
                  if (typeof data.document_id === "string") {
                    next.document_id = data.document_id as string;
                  }
                  if (typeof data.version_id === "string") {
                    next.version_id = data.version_id as string;
                  }
                  if (typeof data.version_number === "number") {
                    next.version_number = data.version_number as number;
                  }
                  return next;
                },
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_replicate_start") {
              pushEvent({
                type: "doc_replicated",
                filename: data.filename as string,
                count:
                  typeof data.count === "number" ? (data.count as number) : 1,
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_replicated") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_replicated" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                () => ({
                  type: "doc_replicated",
                  filename: data.filename as string,
                  count:
                    typeof data.count === "number"
                      ? (data.count as number)
                      : Array.isArray(data.copies)
                        ? (data.copies as unknown[]).length
                        : 1,
                  copies: Array.isArray(data.copies)
                    ? (data.copies as {
                        new_filename: string;
                        document_id: string;
                        version_id: string;
                      }[])
                    : undefined,
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "doc_edited_start") {
              pushEvent({
                type: "doc_edited",
                filename: data.filename as string,
                document_id: "",
                version_id: "",
                download_url: "",
                annotations: [],
                isStreaming: true,
              });
              continue;
            }

            if (data.type === "doc_edited") {
              updateMatchingEvent(
                (e) =>
                  e.type === "doc_edited" &&
                  e.filename === data.filename &&
                  !!e.isStreaming,
                () => ({
                  type: "doc_edited",
                  filename: data.filename as string,
                  document_id: (data.document_id as string) ?? "",
                  version_id: (data.version_id as string) ?? "",
                  version_number:
                    typeof data.version_number === "number"
                      ? (data.version_number as number)
                      : null,
                  download_url: (data.download_url as string) ?? "",
                  annotations: Array.isArray(data.annotations)
                    ? (data.annotations as import("@/app/components/shared/types").EditAnnotation[])
                    : [],
                  error:
                    typeof data.error === "string"
                      ? (data.error as string)
                      : undefined,
                  isStreaming: false,
                }),
              );
              pushThinkingPlaceholder();
              continue;
            }

            if (data.type === "citations") {
              const status =
                data.status === "started" ||
                data.status === "partial" ||
                data.status === "final"
                  ? data.status
                  : "final";
              const incoming = (data.citations ??
                []) as CitationAnnotation[];
              if (status === "started" || status === "partial") {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = {
                      ...last,
                      annotations: incoming,
                      citationStatus: status,
                    };
                  }
                  return updated;
                });
                continue;
              }
              // End-of-stream signal — scrub any lingering
              // placeholders so they don't persist into the
              // finalised message. First finalize content so adding
              // annotations cannot re-render the markdown/citation view
              // against a streaming block.
              finalizeStreamingContent();
              clearStreamingPlaceholders();
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    annotations: incoming,
                    citationStatus: incoming.length ? "final" : undefined,
                  };
                }
                return updated;
              });
              continue;
            }
          } catch (e) {
            console.warn(
              "[useAssistantChat] failed to parse SSE line:",
              trimmed,
              e,
            );
          }
        }
      }

      finalizeStreamingReasoning();
      // Commit any tokens still buffered in a pending coalesced frame so the
      // final message is complete the moment streaming ends.
      flushEventsToMessages();
      setIsResponseLoading(false);
      setIsLoadingCitations(false);

      const finalChatId = streamedChatId || chatId || null;
      if (finalChatId && finalChatId !== chatId) {
        if (chatId) {
          replaceChatId(
            chatId,
            finalChatId,
            message.content.trim().slice(0, 120) || "New Chat",
          );
        }
        setCurrentChatId(finalChatId);
        const chatBasePath = projectId
          ? `/projects/${projectId}/assistant/chat`
          : `/assistant/chat`;
        router.replace(`${chatBasePath}/${finalChatId}`);
      }

      await loadChats();

      const finalChatIdForTitle = streamedChatId || chatId || null;
      if (finalChatIdForTitle && newMessages.length === 1) {
        const titleParts = [message.content];
        if (message.workflow)
          titleParts.push(`Workflow: ${message.workflow.title}`);
        if (message.files?.length)
          titleParts.push(
            `Files: ${message.files.map((f) => f.filename).join(", ")}`,
          );
        void generateTitle(finalChatIdForTitle, titleParts.join("\n"));
      }

      return streamedChatId || null;
    } catch (error: unknown) {
      // Drop any queued coalesced flush so it can't overwrite the terminal
      // (cancelled / error) state a frame later.
      if (flushRafRef.current != null) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
      }
      if (error instanceof Error && error.name === "AbortError") {
        finalizeStreamingContent();
        finalizeStreamingReasoning();
        eventsRef.current = appendCancellationEvent(eventsRef.current);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            const updated = [...prev];
            const events = appendCancellationEvent(
              last.events ?? eventsRef.current,
            );
            eventsRef.current = events;
            updated[updated.length - 1] = {
              ...last,
              events,
            };
            return updated;
          }
          eventsRef.current = [{ type: "content", text: "Cancelled by user." }];
          return [
            ...prev,
            {
              role: "assistant",
              content: "",
              events: [{ type: "content", text: "Cancelled by user." }],
            },
          ];
        });
      } else {
        finalizeStreamingContent();
        const errorMessage =
          error instanceof Error && error.message
            ? error.message
            : "Sorry, something went wrong.";
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...last,
              error: errorMessage,
            };
            return updated;
          }
          return [
            ...prev,
            {
              role: "assistant",
              content: "",
              error: errorMessage,
            },
          ];
        });
      }

      setIsResponseLoading(false);
      setIsLoadingCitations(false);
      return null;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      // Always release: the finally runs from the loop, so it fires even when
      // the page that started this turn is long gone. Without it a closed tab
      // would leave the sidebar pulsing forever.
      if (streamingChatIdRef.current) {
        endStream(streamingChatIdRef.current);
        streamingChatIdRef.current = null;
      }
    }
  };

  const handleNewChat = async (
    message: Message,
    projectId?: string,
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;

    setMessages([message]);
    setNewChatMessages([message]);

    const newChatId = await saveChat(projectId);
    if (newChatId) {
      setChatId(newChatId);
      setCurrentChatId(newChatId);
    }

    return newChatId;
  };

  // Adopt a stream this instance did not start — the user came back to a chat
  // that is still generating. useSyncExternalStore rather than an effect: the
  // registry is an external store, and this keeps the live buffer out of local
  // state entirely, so there is nothing to fall out of sync.
  const subscribeHere = useCallback(
    (onChange: () => void) => subscribeToStream(chatId, onChange),
    [chatId],
  );
  const liveEvents = useSyncExternalStore(
    subscribeHere,
    () => getStreamEvents(chatId),
    () => null,
  );
  const adopted = !ownsCurrentStream && liveEvents ? liveEvents : null;
  const chatIsStreaming = isStreaming(chatId);

  // Splice the live buffer in at render time. The owner already has these
  // events in its own messages, so only a visiting page substitutes.
  const visibleMessages = adopted
    ? (() => {
        const out = [...messages];
        const last = out[out.length - 1];
        if (last?.role === "assistant") {
          out[out.length - 1] = { ...last, events: adopted };
        } else {
          out.push({ role: "assistant", content: "", events: adopted });
        }
        return out;
      })()
    : messages;

  return {
    messages: visibleMessages,
    isResponseLoading: isResponseLoading || (!!adopted && chatIsStreaming),
    setIsResponseLoading,
    isLoadingCitations,
    handleChat,
    handleNewChat,
    setMessages,
    cancel,
    chatId,
  };
}
