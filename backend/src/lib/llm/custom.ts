// Adapter for a custom, user-supplied OpenAI-compatible endpoint (Ollama, LM
// Studio, vLLM, and friends). Unlike ./openai.ts — which speaks the OpenAI
// Responses API (`/v1/responses`) — most self-hosted OpenAI-compatible servers
// only implement the Chat Completions API (`/v1/chat/completions`), so this
// adapter targets that surface. Model names are namespaced with a `custom/`
// prefix elsewhere; callers hand us the already-stripped raw model name.

import type {
  LlmMessage,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";
import { customModelName } from "./models";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const MAX_OUTPUT_TOKENS = 16384;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatToolCallDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type ChatStreamEvent = {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ChatToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  error?: { message?: string; code?: string | number } | string | null;
};

/**
 * Resolve the base URL of the custom endpoint. Falls back to the
 * CUSTOM_LLM_BASE_URL env var so an instance can ship a shared default.
 * Trailing slashes are trimmed; a `/v1` suffix is NOT assumed so users can
 * point at any OpenAI-compatible root (Ollama exposes `/v1`).
 */
export function customBaseUrl(apiKeys?: UserApiKeys): string {
  const url =
    apiKeys?.customBaseUrl?.trim() ||
    process.env.CUSTOM_LLM_BASE_URL?.trim() ||
    "";
  if (!url) {
    throw new Error(
      "Custom LLM base URL is not configured. Set CUSTOM_LLM_BASE_URL or add a base URL in Account > Models & API Keys.",
    );
  }
  return url.replace(/\/+$/, "");
}

export function hasCustomBaseUrl(apiKeys?: UserApiKeys): boolean {
  return !!(
    apiKeys?.customBaseUrl?.trim() || process.env.CUSTOM_LLM_BASE_URL?.trim()
  );
}

/** API key is optional — local endpoints such as Ollama accept any/no key. */
function authHeaders(apiKeys?: UserApiKeys): Record<string, string> {
  const key = apiKeys?.custom?.trim() || process.env.CUSTOM_LLM_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function toChatMessages(
  systemPrompt: string,
  messages: LlmMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (systemPrompt.trim()) out.push({ role: "system", content: systemPrompt });
  for (const message of messages) {
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function extractSseJson(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";

  for (const chunk of chunks) {
    const dataLines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    for (const data of dataLines) {
      if (!data || data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        // Incomplete events stay buffered until the next read.
      }
    }
  }

  return { events, rest };
}

// Tool-call fragments arrive incrementally across deltas, keyed by `index`.
// This accumulates name + argument fragments and materializes them once the
// stream signals completion.
class ToolCallAccumulator {
  private byIndex = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  add(deltas: ChatToolCallDelta[]) {
    for (const delta of deltas) {
      const index = delta.index ?? 0;
      const current = this.byIndex.get(index) ?? { id: "", name: "", args: "" };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.name = delta.function.name;
      if (delta.function?.arguments) current.args += delta.function.arguments;
      this.byIndex.set(index, current);
    }
  }

  get size() {
    return this.byIndex.size;
  }

  materialize(): NormalizedToolCall[] {
    return Array.from(this.byIndex.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => {
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.args || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          input = {};
        }
        return {
          id: call.id || `call_${index}`,
          name: call.name,
          input,
        };
      });
  }
}

function streamFailureMessage(event: ChatStreamEvent): string | null {
  const error = event.error;
  if (!error) return null;
  if (typeof error === "string") return error;
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : "Custom LLM response failed.";
  const code = error.code != null ? String(error.code) : null;
  return code ? `Custom LLM error (${code}): ${message}` : message;
}

function abortError(): Error {
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

/**
 * Errors that mean the endpoint dropped us rather than rejected us.
 *
 * vLLM closes the socket mid-stream when its engine restarts or a worker dies,
 * which surfaces through undici as a bare `TypeError: terminated` with a
 * `SocketError: other side closed` cause — no HTTP status, nothing wrong with
 * the request. Retrying is the right response; retrying a 4xx is not.
 */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransientStreamError(err: unknown): boolean {
  // A rejection carrying an HTTP status is a considered answer, not a drop.
  if (typeof (err as { status?: number })?.status === "number") return false;
  const seen = new Set<unknown>();
  let node: unknown = err;
  while (node && !seen.has(node)) {
    seen.add(node);
    const e = node as { code?: string; name?: string; message?: string; cause?: unknown };
    if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
    if (e.name === "SocketError") return true;
    const message = String(e.message ?? "");
    if (/^terminated$/i.test(message)) return true;
    if (/fetch failed|other side closed|socket hang up|premature close/i.test(message)) {
      return true;
    }
    node = e.cause;
  }
  return false;
}

/** Attempts made for one upstream call, and the pause between them. */
const STREAM_RETRY_ATTEMPTS = Number(
  process.env.CUSTOM_LLM_STREAM_RETRIES ?? "3",
);
const STREAM_RETRY_DELAY_MS = Number(
  process.env.CUSTOM_LLM_STREAM_RETRY_DELAY_MS ?? "1000",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postChatCompletion(params: {
  baseUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> {
  const response = await fetch(`${params.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.body),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const err = new Error(
      `Custom LLM request failed (${response.status}): ${text || response.statusText}`,
    );
    (err as { status?: number }).status = response.status;
    throw err;
  }

  return response;
}

/**
 * postChatCompletion with retries for a dropped connection.
 *
 * Safe to retry unconditionally: this resolves as soon as the response headers
 * arrive, before any body is read, so nothing has been emitted downstream yet.
 * An aborted request (the user pressed stop) is never retried.
 */
async function postChatCompletionWithRetry(
  params: Parameters<typeof postChatCompletion>[0],
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STREAM_RETRY_ATTEMPTS; attempt++) {
    try {
      return await postChatCompletion(params);
    } catch (err) {
      if (params.signal?.aborted) throw err;
      if (!isTransientStreamError(err) || attempt === STREAM_RETRY_ATTEMPTS) {
        throw err;
      }
      lastError = err;
      console.warn(
        `[custom-llm] request dropped (attempt ${attempt}/${STREAM_RETRY_ATTEMPTS}), retrying in ${
          STREAM_RETRY_DELAY_MS
        }ms:`,
        err instanceof Error ? err.message : err,
      );
      await sleep(STREAM_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

export async function streamCustom(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const {
    model,
    systemPrompt,
    tools = [],
    callbacks = {},
    runTools,
    apiKeys,
  } = params;
  const maxIter = params.maxIterations ?? 10;
  const baseUrl = customBaseUrl(apiKeys);
  const headers = authHeaders(apiKeys);
  const rawModel = customModelName(model);
  const chatTools: OpenAIToolSchema[] = tools;
  const messages = toChatMessages(systemPrompt, params.messages);
  let fullText = "";
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "custom",
    model: rawModel,
  });

  // Whether the loop ended with the model producing a plain answer, as opposed
  // to exhausting its tool-call budget while still mid-research.
  let finishedWithFinalAnswer = false;

  // Final-synthesis pass: a tools-disabled completion whose content is streamed
  // to the caller. Used when the model burned every tool-call round without
  // ever writing an answer, so the user would otherwise get an empty response.
  const streamFinalAnswer = async () => {
    const response = await postChatCompletion({
      baseUrl,
      headers,
      body: {
        model: rawModel,
        messages,
        stream: true,
        max_tokens: MAX_OUTPUT_TOKENS,
      },
      signal: params.abortSignal,
    });
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawReasoning = false;

    while (true) {
      throwIfAborted(params.abortSignal);
      const { done, value } = await reader.read();
      if (done) break;

      const decoded = decoder.decode(value, { stream: true });
      logRawLlmStream({
        provider: "custom",
        model: rawModel,
        iteration: maxIter,
        label: "synthesis_chunk",
        payload: decoded,
      });
      rawStreamRecorder?.record({
        iteration: maxIter,
        label: "synthesis_chunk",
        payload: decoded,
      });
      buffer += decoded;
      const extracted = extractSseJson(buffer);
      buffer = extracted.rest;

      for (const event of extracted.events as ChatStreamEvent[]) {
        const failureMessage = streamFailureMessage(event);
        if (failureMessage) throw new Error(failureMessage);

        const delta = event.choices?.[0]?.delta;
        if (!delta) continue;

        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          sawReasoning = true;
          callbacks.onReasoningDelta?.(reasoning);
        }
        if (typeof delta.content === "string" && delta.content) {
          fullText += delta.content;
          callbacks.onContentDelta?.(delta.content);
        }
      }
    }

    if (sawReasoning) callbacks.onReasoningBlockEnd?.();
  };

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);
      // vLLM drops the socket mid-stream when its engine restarts, which
      // undici reports as a bare "terminated". Re-issue the request when that
      // happens, but ONLY while this attempt has emitted nothing: once a
      // delta has reached the browser, a retry would replay it and the user
      // would watch the answer write itself twice. A drop after output is
      // still surfaced as an error rather than silently patched over.
      let toolCalls = new ToolCallAccumulator();
      let sawReasoning = false;
      let assistantText = "";

      for (let attempt = 1; ; attempt++) {
      const response = await postChatCompletionWithRetry({
        baseUrl,
        headers,
        body: {
          model: rawModel,
          messages,
          tools: chatTools.length ? chatTools : undefined,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
        },
        signal: params.abortSignal,
      });
      if (!response.body) throw new Error("Custom LLM response had no body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      toolCalls = new ToolCallAccumulator();
      let buffer = "";
      sawReasoning = false;
      assistantText = "";
      let emitted = false;

      try {
      while (true) {
        throwIfAborted(params.abortSignal);
        const { done, value } = await reader.read();
        if (done) break;

        const decoded = decoder.decode(value, { stream: true });
        logRawLlmStream({
          provider: "custom",
          model: rawModel,
          iteration: iter,
          label: "sse_chunk",
          payload: decoded,
        });
        rawStreamRecorder?.record({
          iteration: iter,
          label: "sse_chunk",
          payload: decoded,
        });
        buffer += decoded;
        const extracted = extractSseJson(buffer);
        buffer = extracted.rest;

        for (const event of extracted.events as ChatStreamEvent[]) {
          rawStreamRecorder?.record({
            iteration: iter,
            label: "sse_event",
            payload: event,
          });

          const failureMessage = streamFailureMessage(event);
          if (failureMessage) throw new Error(failureMessage);

          const choice = event.choices?.[0];
          const delta = choice?.delta;
          if (!delta) continue;

          const reasoning = delta.reasoning ?? delta.reasoning_content;
          if (typeof reasoning === "string" && reasoning) {
            sawReasoning = true;
            emitted = true;
            callbacks.onReasoningDelta?.(reasoning);
          }

          if (typeof delta.content === "string" && delta.content) {
            fullText += delta.content;
            assistantText += delta.content;
            emitted = true;
            callbacks.onContentDelta?.(delta.content);
          }

          if (delta.tool_calls?.length) {
            emitted = true;
            toolCalls.add(delta.tool_calls);
          }
        }
      }
      break;
      } catch (err) {
        // fullText only grows alongside assistantText, so an attempt that
        // emitted nothing has left no trace to roll back.
        if (
          params.abortSignal?.aborted ||
          emitted ||
          !isTransientStreamError(err) ||
          attempt >= STREAM_RETRY_ATTEMPTS
        ) {
          throw err;
        }
        console.warn(
          `[custom-llm] stream dropped before any output (attempt ${attempt}/${STREAM_RETRY_ATTEMPTS}), retrying:`,
          err instanceof Error ? err.message : err,
        );
        await sleep(STREAM_RETRY_DELAY_MS * attempt);
      }
      }

      if (sawReasoning) callbacks.onReasoningBlockEnd?.();
      throwIfAborted(params.abortSignal);

      if (!toolCalls.size || !runTools) {
        finishedWithFinalAnswer = true;
        break;
      }

      // Fire the start callback once per call now that arguments are fully
      // assembled, so the UI sees complete tool inputs.
      const calls = toolCalls.materialize();
      for (const call of calls) callbacks.onToolCallStart?.(call);
      messages.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input),
          },
        })),
      });

      const results = await runTools(calls);
      throwIfAborted(params.abortSignal);
      for (const result of results) {
        messages.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: result.content,
        });
      }
    }

    // The model used its entire tool-call budget without ever writing a plain
    // answer. Force one final tools-disabled pass so it must synthesize a
    // response for the user from the tool output gathered above — otherwise the
    // turn ends with only tool activity and no answer.
    if (!finishedWithFinalAnswer) {
      throwIfAborted(params.abortSignal);
      // Sent as a user turn, not a system one: vLLM (and other strict
      // OpenAI-compatible servers) reject a system message that is not the
      // first in the conversation — "System message must be at the beginning" —
      // which failed the whole turn with a 400 at exactly the moment this pass
      // exists to rescue.
      messages.push({
        role: "user",
        content:
          "You have gathered enough information using the tools. Do not request any more tools. Write your complete final answer for the user now, based only on the information already gathered above.",
      });
      await streamFinalAnswer();
    }

    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    throw error;
  }
}

export async function completeCustomText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
}): Promise<string> {
  const baseUrl = customBaseUrl(params.apiKeys);
  const messages = toChatMessages(params.systemPrompt ?? "", [
    { role: "user", content: params.user },
  ]);
  const response = await postChatCompletion({
    baseUrl,
    headers: authHeaders(params.apiKeys),
    body: {
      model: customModelName(params.model),
      messages,
      max_tokens: params.maxTokens ?? 512,
      stream: false,
    },
  });
  const json = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

/**
 * One-shot vision completion: a text instruction plus one image.
 *
 * Deliberately narrow. The streaming path speaks text-only `{role, content}`
 * messages across every provider, and widening that union to carry image parts
 * would touch all four adapters for the sake of one caller (OCR of scanned
 * legislation). If a second vision use case appears, generalise then.
 *
 * `imageBase64` is raw base64 with no data: prefix.
 */
export async function completeCustomVision(params: {
  model: string;
  instruction: string;
  imageBase64: string;
  imageMimeType?: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
}): Promise<string> {
  const baseUrl = customBaseUrl(params.apiKeys);
  const response = await postChatCompletion({
    baseUrl,
    headers: authHeaders(params.apiKeys),
    body: {
      model: customModelName(params.model),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: params.instruction },
            {
              type: "image_url",
              image_url: {
                url: `data:${params.imageMimeType ?? "image/png"};base64,${params.imageBase64}`,
              },
            },
          ],
        },
      ],
      max_tokens: params.maxTokens ?? 4000,
      stream: false,
    },
  });
  const json = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

export type CustomModelOption = { id: string; name: string };

/**
 * List models advertised by the custom endpoint's OpenAI-compatible
 * `/models` route. Returns raw endpoint names; callers namespace them with the
 * `custom/` prefix as needed.
 */
export async function listCustomModels(
  apiKeys?: UserApiKeys,
): Promise<CustomModelOption[]> {
  const baseUrl = customBaseUrl(apiKeys);
  const response = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...authHeaders(apiKeys),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to list custom models (${response.status}): ${text || response.statusText}`,
    );
  }
  const json = (await response.json()) as {
    data?: { id?: unknown }[];
    models?: { id?: unknown; name?: unknown }[];
  };
  // OpenAI-compatible shape is `{ data: [{ id }] }`; some servers use
  // `{ models: [{ name }] }` (older Ollama), so accept both.
  const rows = json.data ?? json.models ?? [];
  const names = rows
    .map((row) =>
      typeof row.id === "string"
        ? row.id
        : typeof (row as { name?: unknown }).name === "string"
          ? ((row as { name: string }).name)
          : null,
    )
    .filter((name): name is string => !!name);
  const unique = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  return unique.map((name) => ({ id: name, name }));
}

export type { NormalizedToolResult };
