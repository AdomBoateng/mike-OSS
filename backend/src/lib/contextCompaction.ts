// Keeping a long conversation inside the model's context window.
//
// buildMessages sends every turn of a chat on every request, and nothing
// bounded it. A working session — read a lease, redraft it, revise, revise
// again — grows without limit until the endpoint rejects the request or drops
// the connection mid-answer, which is what a user sees as "terminated".
//
// So the oldest turns are folded into a summary once the request gets close to
// the window, and the recent ones are kept verbatim. The recent turns are what
// the model is actually working with; the older ones matter as context, not as
// exact text.
//
// Two things this deliberately does NOT do:
//
//   * It never touches the system message, which carries the tool contract and
//     the document list. Losing that changes how the assistant behaves.
//   * It never silently drops content. Compaction emits an event so the UI can
//     say the earlier part of the conversation was summarised — quietly losing
//     a lawyer's earlier instructions would be worse than refusing outright.

import { completeText, type UserApiKeys } from "./llm";

export interface ChatApiMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface CompactionOutcome {
  messages: ChatApiMessage[];
  /** Null when nothing needed doing. */
  compacted: {
    summarisedTurns: number;
    tokensBefore: number;
    tokensAfter: number;
    /** True when the model could not summarise and the tail was kept instead. */
    degraded: boolean;
  } | null;
}

/**
 * Total context the endpoint accepts, in tokens. vLLM's /models route does not
 * advertise max_model_len, so this cannot be detected and must be configured.
 * The default is deliberately conservative: compacting a little early costs one
 * cheap call, whereas guessing high means the request is rejected outright.
 */
function contextWindowTokens(): number {
  return Number(process.env.CONTEXT_WINDOW_TOKENS ?? "32768");
}

/** Fraction of the window at which compaction kicks in. */
function compactAtFraction(): number {
  return Number(process.env.CONTEXT_COMPACT_AT ?? "0.7");
}

/** Turns always kept verbatim, however long the conversation is. */
function keepRecentTurns(): number {
  return Math.max(2, Number(process.env.CONTEXT_KEEP_RECENT_TURNS ?? "6"));
}

/**
 * Characters per token. Real tokenisers vary by model and none is available
 * here without pulling in a large dependency, so this is an estimate — and it
 * is deliberately low (English averages nearer 4) so the estimate runs high
 * and compaction happens early rather than one turn too late.
 */
const CHARS_PER_TOKEN = 3.5;

/** Per-message envelope cost: role, delimiters, and the JSON around them. */
const MESSAGE_OVERHEAD_TOKENS = 4;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  // Tool calls and structured content still occupy the window.
  return JSON.stringify(content);
}

export function estimateMessageTokens(message: ChatApiMessage): number {
  const body = textOf(message.content);
  const extras = Object.entries(message)
    .filter(([k]) => k !== "role" && k !== "content")
    .map(([, v]) => textOf(v))
    .join("");
  return (
    Math.ceil((body.length + extras.length) / CHARS_PER_TOKEN) +
    MESSAGE_OVERHEAD_TOKENS
  );
}

export function estimateTokens(messages: ChatApiMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

export function compactionThreshold(): number {
  return Math.floor(contextWindowTokens() * compactAtFraction());
}

/** Render turns for the summariser, capped so the summary call itself fits. */
function transcriptFor(messages: ChatApiMessage[], maxChars = 24000): string {
  const lines = messages.map((m) => {
    const body = textOf(m.content).trim();
    return `${m.role.toUpperCase()}: ${body}`;
  });
  const joined = lines.join("\n\n");
  if (joined.length <= maxChars) return joined;
  // Keep the end: the most recent of the *old* turns are the ones the later
  // conversation actually builds on.
  return `[earlier turns omitted]\n\n${joined.slice(joined.length - maxChars)}`;
}

const SUMMARY_INSTRUCTION =
  "Summarise the earlier part of this legal-assistant conversation so it can " +
  "replace the original turns without losing anything the assistant needs to " +
  "continue. Preserve: what the user asked for and any standing instructions " +
  "or preferences they gave; which documents were discussed, by name and id; " +
  "decisions, drafting choices and agreed wording; and anything the assistant " +
  "committed to doing. Do not add commentary, do not evaluate the exchange, " +
  "and do not invent detail. Write it as notes for yourself, not as a report " +
  "to the user.";

/**
 * Fold the oldest turns into a summary when the request approaches the window.
 *
 * Returns the original array untouched when nothing needs doing, so the common
 * case costs one cheap estimate and no model call.
 */
export async function compactIfNeeded(params: {
  messages: ChatApiMessage[];
  model: string;
  apiKeys?: UserApiKeys;
}): Promise<CompactionOutcome> {
  const { messages, model, apiKeys } = params;
  const tokensBefore = estimateTokens(messages);
  if (tokensBefore <= compactionThreshold()) {
    return { messages, compacted: null };
  }

  // The system message is structural, never conversational: it carries the
  // tool contract and the document list, so it is preserved as-is.
  const systemMessages = messages.filter((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");

  // Nothing to gain if there is not enough history to fold away.
  const keep = keepRecentTurns();
  if (turns.length <= keep + 1) {
    return { messages, compacted: null };
  }

  const older = turns.slice(0, turns.length - keep);
  const recent = turns.slice(turns.length - keep);

  let summary: string | null = null;
  try {
    const text = await completeText({
      model,
      systemPrompt: SUMMARY_INSTRUCTION,
      user: transcriptFor(older),
      // Reasoning models spend the early budget on reasoning_content before
      // emitting anything visible; too small a cap returns an empty string.
      maxTokens: 1500,
      apiKeys,
    });
    summary = text.trim() || null;
  } catch {
    // Endpoint down or the summary itself too large. Fall through: dropping
    // the oldest turns is worse than summarising them but far better than
    // failing the user's request outright.
    summary = null;
  }

  const note: ChatApiMessage = summary
    ? {
        role: "user",
        content:
          "[Summary of the earlier part of this conversation, which has been " +
          "condensed to stay within the context limit. Treat it as an " +
          "accurate record of what came before.]\n\n" +
          summary,
      }
    : {
        role: "user",
        content:
          `[${older.length} earlier messages in this conversation were dropped ` +
          "to stay within the context limit, and could not be summarised. " +
          "If you need something from earlier in the conversation, say so " +
          "rather than guessing at it.]",
      };

  const compactedMessages = [...systemMessages, note, ...recent];
  return {
    messages: compactedMessages,
    compacted: {
      summarisedTurns: older.length,
      tokensBefore,
      tokensAfter: estimateTokens(compactedMessages),
      degraded: summary === null,
    },
  };
}
