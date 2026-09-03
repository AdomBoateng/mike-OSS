// Web search via a SearXNG instance.
//
// SearXNG is a metasearch engine you run yourself: it forwards a query to
// upstream engines and returns aggregated results. That matters here more than
// it would elsewhere — this app is sold on the basis that client material stays
// inside the firm's network, so the search backend is deliberately one the firm
// operates rather than a commercial API that would receive every query a lawyer
// types.
//
// Two things callers must keep in mind:
//
//   * Results are UNTRUSTED THIRD-PARTY TEXT. Titles and snippets are written
//     by whoever controls the page. They are data for the model to read, never
//     instructions for it to follow, and the system prompt says so.
//   * This searches the open web, which is not a legal authority. A blog post
//     agreeing with a proposition is not a source of law. The prompt is explicit
//     that statute and case law come from the dedicated tools.
//
// Nothing here fetches a page's full text. Doing so would mean issuing requests
// to arbitrary URLs from a server that sits on the same network as LDAP, the
// database and object storage — a server-side request forgery risk that needs
// its own design (private-range denylist, redirect handling, size caps) rather
// than being tacked on here.

const DEFAULT_TIMEOUT_MS = Number(
  process.env.SEARXNG_REQUEST_TIMEOUT_MS ?? "15000",
);

/** Results returned to the model for one query. */
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;

/** Snippets are truncated: a long one crowds out the rest of the results. */
const MAX_SNIPPET_CHARS = 400;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** The upstream engine SearXNG got this from, e.g. "duckduckgo". */
  engine?: string;
  /** Publication date when the engine supplies one. */
  publishedAt?: string;
}

export function webSearchBaseUrl(): string | null {
  const raw = process.env.SEARXNG_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/**
 * Enabled only when an instance is configured. There is no public fallback on
 * purpose: silently sending a firm's queries to someone else's SearXNG would
 * defeat the reason for choosing SearXNG.
 */
export function webSearchEnabled(): boolean {
  return (
    (process.env.WEB_SEARCH_ENABLED ?? "true").toLowerCase() !== "false" &&
    webSearchBaseUrl() !== null
  );
}

function clean(value: unknown, max = MAX_SNIPPET_CHARS): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

interface SearxngResponse {
  results?: {
    title?: unknown;
    url?: unknown;
    content?: unknown;
    engine?: unknown;
    publishedDate?: unknown;
  }[];
}

export interface WebSearchOutcome {
  results: WebSearchResult[];
  /** Set when the search could not run; `results` is then empty. */
  error?: string;
}

/**
 * Run one query against the configured SearXNG instance.
 *
 * Failure is returned rather than thrown: a search that cannot run should let
 * the assistant say so and carry on with the tools that do work, not abort the
 * whole turn.
 */
export async function searchWeb(params: {
  query: string;
  limit?: number;
  /** SearXNG category, e.g. "general" or "news". */
  category?: string;
}): Promise<WebSearchOutcome> {
  const base = webSearchBaseUrl();
  if (!base) {
    return {
      results: [],
      error:
        "Web search is not configured on this deployment (SEARXNG_BASE_URL is unset).",
    };
  }

  const query = params.query?.trim();
  if (!query) return { results: [], error: "Empty query." };

  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  // SearXNG only returns JSON when the instance allows that format; a default
  // install serves HTML only, which is why a misconfigured instance shows up
  // here as a parse failure rather than an empty result.
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");
  if (params.category) url.searchParams.set("categories", params.category);

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail =
        res.status === 403
          ? "the instance refused the request — check that the JSON format is enabled in its settings.yml"
          : res.statusText;
      return {
        results: [],
        error: `Search failed (${res.status}): ${detail}`,
      };
    }

    const body = (await res.json()) as SearxngResponse;
    const raw = Array.isArray(body.results) ? body.results : [];
    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const link = clean(item.url, 2000);
      const title = clean(item.title, 200);
      if (!link || !title) continue;
      // Metasearch returns the same page from several engines; the model does
      // not benefit from reading it three times.
      if (seen.has(link)) continue;
      seen.add(link);
      results.push({
        title,
        url: link,
        snippet: clean(item.content),
        engine: clean(item.engine, 40) || undefined,
        publishedAt: clean(item.publishedDate, 40) || undefined,
      });
      if (results.length >= limit) break;
    }
    return { results };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? `the search instance did not respond within ${DEFAULT_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : "unknown error";
    return { results: [], error: `Search failed: ${message}` };
  }
}
