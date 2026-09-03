const SECRET_CONTEXT_PATTERNS = [
  /(Incorrect API key provided:\s*)([^.\s]+)(\.?)/gi,
  /(api[_ -]?key|x-api-key|token|secret|authorization|bearer)\s*(?:provided\s*)?(?:is|:|=)\s*["']?([A-Za-z0-9._\-]{6,})["']?/gi,
];

const PROVIDER_KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{12,}\b/g,
  /\bsk-ant-[A-Za-z0-9_\-]{12,}\b/g,
  /\bsk-or-[A-Za-z0-9_\-]{12,}\b/g,
  /\bAIza[A-Za-z0-9_\-]{20,}\b/g,
];

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_CONTEXT_PATTERNS) {
    redacted = redacted.replace(pattern, (match, ...groups: string[]) => {
      if (match.toLowerCase().startsWith("incorrect api key provided:")) {
        return `${groups[0]}[redacted]${groups[2] ?? ""}`;
      }
      const secret = groups[1];
      return secret ? match.replace(secret, "[redacted]") : match;
    });
  }
  for (const pattern of PROVIDER_KEY_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

export function safeErrorMessage(
  error: unknown,
  fallback = "Unexpected error",
): string {
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string"
        ? error
        : fallback;
  return redactSensitiveText(message);
}

export type SafeErrorEntry = {
  name: string | null;
  message: string;
  stack?: string;
};

export type SafeErrorLog = SafeErrorEntry & {
  /**
   * The `cause` chain, flattened outermost-first and excluding the error
   * itself. Without this the most important errors log as a bare one-liner:
   * undici throws `TypeError: terminated` when a response body is cut short
   * and puts the actual fault — `SocketError: other side closed`,
   * `ECONNRESET`, `BodyTimeoutError`, `HeadersTimeoutError` — in `cause`, and
   * those have entirely different fixes.
   *
   * Flat rather than nested because `console.error` inspects objects two
   * levels deep by default, which would print a nested chain as `[Object]`.
   */
  causes?: SafeErrorEntry[];
};

/** How far to follow `cause` before giving up. */
const MAX_CAUSE_DEPTH = 5;

function describeError(error: unknown): SafeErrorEntry {
  if (error instanceof Error) {
    return {
      name: error.name || null,
      message: redactSensitiveText(error.message || "Unexpected error"),
      stack: error.stack ? redactSensitiveText(error.stack) : undefined,
    };
  }
  return {
    name: null,
    message: safeErrorMessage(error),
  };
}

function causeChain(error: unknown): SafeErrorEntry[] {
  const chain: SafeErrorEntry[] = [];
  // A `cause` that points back up the chain would otherwise loop forever.
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (chain.length < MAX_CAUSE_DEPTH) {
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const next = (current as { cause?: unknown }).cause;
    if (next === undefined || next === null) break;
    chain.push(describeError(next));
    current = next;
  }
  return chain;
}

export function safeErrorLog(error: unknown): SafeErrorLog {
  const entry = describeError(error);
  const causes = causeChain(error);
  return causes.length ? { ...entry, causes } : entry;
}
