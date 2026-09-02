/**
 * Registry of chat streams that are currently running.
 *
 * The problem this solves: streaming state lives in useAssistantChat, which the
 * chat page owns. Opening another chat unmounts that page, and the remounted
 * one starts from the messages the server has saved — which cannot include an
 * answer still being written. The request itself is fine (nothing aborts the
 * fetch on unmount, so the backend runs to completion and persists), but the
 * user is shown their own question and nothing else, and the composer offers
 * "send" rather than "stop". It looks broken while it is working.
 *
 * So the live event buffer is mirrored here, outside React, keyed by chat id.
 *
 * WHY NOT A REACT EFFECT: the obvious implementation publishes from an effect
 * on the owner's state. That cannot work. React does not re-render an unmounted
 * component, so its effects stop firing the moment the page is closed — the
 * registry would freeze at the last pre-unmount snapshot and never be told the
 * stream ended, stranding every other page on a spinner that never resolves.
 * Publishing therefore happens from the streaming loop itself, which is plain
 * JavaScript in a closure and keeps running regardless of what React is doing.
 */

import type { AssistantEvent } from "@/app/components/shared/types";

interface StreamEntry {
  /** The live event buffer, replaced (never mutated) so identity signals change. */
  events: AssistantEvent[];
  isLoading: boolean;
  abort: (() => void) | null;
  subscribers: Set<() => void>;
}

const streams = new Map<string, StreamEntry>();
/** Notified when any chat starts or finishes streaming — drives the sidebar. */
const rosterListeners = new Set<() => void>();

function notifyRoster(): void {
  rebuildRoster();
  for (const listener of rosterListeners) listener();
}

function entryFor(chatId: string): StreamEntry {
  let entry = streams.get(chatId);
  if (!entry) {
    entry = { events: [], isLoading: false, abort: null, subscribers: new Set() };
    streams.set(chatId, entry);
  }
  return entry;
}

/** Mark a chat as streaming. Called from the loop, not from an effect. */
export function startStream(chatId: string, abort: (() => void) | null): void {
  const entry = entryFor(chatId);
  entry.isLoading = true;
  entry.abort = abort;
  entry.events = [];
  for (const s of entry.subscribers) s();
  notifyRoster();
}

/**
 * Mirror the current event buffer. The array is copied by the caller and stored
 * by reference, so getStreamEvents can hand useSyncExternalStore a snapshot
 * that is stable until something actually changes — returning a fresh array
 * each read would spin React in an infinite re-render.
 */
export function publishStreamEvents(
  chatId: string,
  events: AssistantEvent[],
): void {
  const entry = streams.get(chatId);
  if (!entry?.isLoading) return;
  entry.events = events;
  for (const s of entry.subscribers) s();
}

/**
 * Mark a chat as finished.
 *
 * The entry is kept rather than deleted: a page watching this chat is rendering
 * from `events`, and dropping them would blank the answer it just finished
 * showing. It is cleared when that chat next starts streaming, or when a page
 * that owns the chat takes over.
 */
export function endStream(chatId: string): void {
  const entry = streams.get(chatId);
  if (!entry) return;
  entry.isLoading = false;
  entry.abort = null;
  for (const s of entry.subscribers) s();
  notifyRoster();
}

/** Forget a chat entirely — used when its own page takes ownership again. */
export function clearStream(chatId: string): void {
  const entry = streams.get(chatId);
  if (!entry || entry.isLoading) return;
  streams.delete(chatId);
  for (const s of entry.subscribers) s();
}

/** Snapshot for useSyncExternalStore. Stable identity between publishes. */
export function getStreamEvents(chatId: string | undefined): AssistantEvent[] | null {
  if (!chatId) return null;
  const entry = streams.get(chatId);
  if (!entry || entry.events.length === 0) return null;
  return entry.events;
}

export function isStreaming(chatId: string | undefined): boolean {
  return !!chatId && streams.get(chatId)?.isLoading === true;
}

export function subscribeToStream(
  chatId: string | undefined,
  onChange: () => void,
): () => void {
  if (!chatId) return () => {};
  const entry = entryFor(chatId);
  entry.subscribers.add(onChange);
  return () => {
    entry.subscribers.delete(onChange);
  };
}

/** Stop a stream this page does not own — the registry holds the handle. */
export function abortStream(chatId: string): void {
  streams.get(chatId)?.abort?.();
}

/**
 * Ids of chats currently generating, for the sidebar indicator.
 *
 * Cached, and only rebuilt when the roster actually changes: this is a
 * useSyncExternalStore snapshot, and returning a fresh array on every read
 * would make React re-render forever chasing a value that never settles.
 */
let rosterSnapshot: string[] = [];

function rebuildRoster(): void {
  const ids: string[] = [];
  for (const [id, entry] of streams) if (entry.isLoading) ids.push(id);
  const changed =
    ids.length !== rosterSnapshot.length ||
    ids.some((id, i) => rosterSnapshot[i] !== id);
  if (changed) rosterSnapshot = ids;
}

export function streamingChatIds(): string[] {
  return rosterSnapshot;
}

export function subscribeToRoster(onChange: () => void): () => void {
  rosterListeners.add(onChange);
  return () => {
    rosterListeners.delete(onChange);
  };
}
