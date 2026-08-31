// Ghana primary legislation, from the Parliament of Ghana Library Repository.
//
// The repository runs DSpace 9 and exposes an open, unauthenticated REST API at
// /server/api. No key is required, which is why this source has no entry in
// userApiKeys.
//
// WHAT THIS CAN AND CANNOT DO — read before extending:
//
//   * The corpus is legislation **as enacted**. Amendments are filed as their
//     own items ("X (Amendment) Act, 2025"), never folded into the principal
//     Act, and the consolidated "Revised Edition" series is image-only. Nothing
//     here states the law in force; callers must say so.
//   * Roughly a third of items are scanned images with no text layer, and the
//     year does not predict which (a 2025 Act in the survey was a scan). Every
//     fetch is assessed, and a scan is reported as such rather than returned as
//     empty text — see assessExtractedText in ./pdfText for why that matters.
//   * Subsidiary legislation is barely represented (14 Legislative Instruments
//     at the time of writing), so absence of a result is not evidence of
//     absence in law.
//   * The repository indexes Hansard, committee reports and budget papers in
//     the same search index as legislation. Searches here are always scoped to
//     the legislation collections; an unscoped query returns committee reports
//     that look plausible and are not the law.

import { downloadFile, uploadFile, isStorageEnabled } from "./storage";
import { extractPdfText, assessExtractedText, type TextQuality } from "./pdfText";
import { ocrAvailable, ocrPdfPages, OCR_MAX_PAGES } from "./ocr";
import type { UserApiKeys } from "./llm";

const DEFAULT_BASE_URL = "https://repository.parliament.gh/server/api";

/** Cache prefix for extracted text, mirroring the CourtListener bulk layout. */
const CACHE_PREFIX = "ghana-law/items";

const REQUEST_TIMEOUT_MS = Number(
  process.env.GHANA_LAW_REQUEST_TIMEOUT_MS ?? "30000",
);
const DOWNLOAD_TIMEOUT_MS = Number(
  process.env.GHANA_LAW_DOWNLOAD_TIMEOUT_MS ?? "120000",
);
/** Refuse absurdly large PDFs rather than spend minutes extracting them. */
const MAX_PDF_BYTES = Number(process.env.GHANA_LAW_MAX_PDF_BYTES ?? "26214400");

/**
 * Collections that hold primary legislation, by name as they appear in the
 * repository. Resolved to UUIDs at first use: UUIDs are instance-specific and
 * would silently break if the repository were rebuilt, whereas these names are
 * editorial and stable.
 */
const LEGISLATION_COLLECTION_PATTERNS: RegExp[] = [
  /\bacts?\b/i,
  /\b(constitutional|executive|legislative)\s+instruments?\b/i,
  /\bdecree\b/i,
];

/** Collections whose names match above but which are not legislation. */
const COLLECTION_EXCLUSIONS = /report|estimate|budget|annual|hansard|order paper/i;

/**
 * Item titles that are not legislation even though they sit in a legislation
 * collection. Scoping by collection is necessary but not sufficient: the
 * repository files committee reports alongside the instruments they concern, so
 * a search for "Road Traffic Amendment" returns "Report of the Committee on
 * Subsidiary Legislation on the Road Traffic (Amendment) Regulations" — which
 * reads like law and is not.
 */
const NON_LEGISLATION_TITLE =
  /^\s*(report|memorandum|minutes|order paper|votes and proceedings)\b/i;

export function ghanaLawBaseUrl(): string {
  return (process.env.GHANA_LAW_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

/** Disabled by setting GHANA_LAW_ENABLED=false; on by default (no key needed). */
export function ghanaLawEnabled(): boolean {
  return (process.env.GHANA_LAW_ENABLED ?? "true").toLowerCase() !== "false";
}

export interface LegislationItem {
  uuid: string;
  title: string;
  /** dc.date.issued, as recorded — often just a year. */
  issued: string | null;
  collection: string | null;
  /** Human-facing page in the repository, for citation. */
  url: string;
}

export interface LegislationText {
  item: LegislationItem;
  quality: TextQuality;
  /** Empty unless quality is "text" or "ocr". */
  text: string;
  pages: number;
  chars: number;
  /**
   * Name of the PDF actually attached. Repository metadata is not always
   * consistent with it (an item titled "…Act 342" carrying "ACT 351.pdf" was
   * observed), so callers should surface both and let the reader judge.
   */
  filename: string | null;
  /** Set when quality is "ocr": how much of the document was transcribed. */
  ocr?: { pagesRead: number; truncated: boolean };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Ghana law repository returned ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

// --- collection resolution -------------------------------------------------

let collectionCache: { uuids: string[]; names: Map<string, string> } | null =
  null;

/** Resolve the legislation collection UUIDs, caching for the process lifetime. */
export async function legislationCollections(): Promise<{
  uuids: string[];
  names: Map<string, string>;
}> {
  if (collectionCache) return collectionCache;
  const data = await getJson<{
    _embedded?: { collections?: { uuid: string; name: string }[] };
  }>(`${ghanaLawBaseUrl()}/core/collections?size=200`);
  const all = data._embedded?.collections ?? [];
  const matched = all.filter(
    (c) =>
      LEGISLATION_COLLECTION_PATTERNS.some((re) => re.test(c.name)) &&
      !COLLECTION_EXCLUSIONS.test(c.name),
  );
  collectionCache = {
    uuids: matched.map((c) => c.uuid),
    names: new Map(matched.map((c) => [c.uuid, c.name])),
  };
  return collectionCache;
}

/** Test seam — clears the memoised collection lookup. */
export function resetGhanaLawCache(): void {
  collectionCache = null;
}

// --- search ----------------------------------------------------------------

interface SearchObject {
  _embedded?: {
    indexableObject?: {
      uuid?: string;
      name?: string;
      metadata?: Record<string, { value?: string }[]>;
    };
  };
}

function toItem(
  obj: SearchObject,
  names: Map<string, string>,
  collectionUuid?: string,
): LegislationItem | null {
  const i = obj._embedded?.indexableObject;
  if (!i?.uuid || !i?.name) return null;
  return {
    uuid: i.uuid,
    title: i.name,
    issued: i.metadata?.["dc.date.issued"]?.[0]?.value ?? null,
    collection: collectionUuid ? (names.get(collectionUuid) ?? null) : null,
    url: `${ghanaLawBaseUrl().replace(/\/server\/api$/, "")}/items/${i.uuid}`,
  };
}

/**
 * Search legislation. Always scoped to the legislation collections — DSpace
 * accepts one scope per query, so this fans out and merges rather than issuing
 * a single unscoped search that would surface committee reports as if they were
 * statutes.
 */
export async function searchLegislation(
  query: string,
  opts: { limit?: number } = {},
): Promise<LegislationItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const { uuids, names } = await legislationCollections();
  const perScope = Math.max(3, Math.ceil(limit / Math.max(uuids.length, 1)) + 2);

  const results = await Promise.allSettled(
    uuids.map(async (uuid) => {
      const data = await getJson<{
        _embedded?: { searchResult?: { _embedded?: { objects?: SearchObject[] } } };
      }>(
        `${ghanaLawBaseUrl()}/discover/search/objects?scope=${encodeURIComponent(uuid)}` +
          `&dsoType=item&size=${perScope}&query=${encodeURIComponent(query)}`,
      );
      const objs = data._embedded?.searchResult?._embedded?.objects ?? [];
      return objs
        .map((o) => toItem(o, names, uuid))
        .filter((x): x is LegislationItem => !!x)
        .filter((x) => !NON_LEGISLATION_TITLE.test(x.title));
    }),
  );

  const seen = new Set<string>();
  const merged: LegislationItem[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      if (seen.has(item.uuid)) continue;
      seen.add(item.uuid);
      merged.push(item);
    }
  }
  return merged.slice(0, limit);
}

/**
 * Find amendment Acts for a principal Act by name.
 *
 * This is the mitigation for the consolidation gap: the repository cannot tell
 * us the amended text, but it can tell us that amendments exist, so an answer
 * can at least name what it has not accounted for.
 */
export async function findAmendments(
  actName: string,
): Promise<LegislationItem[]> {
  const stem = principalActStem(actName);
  if (!stem) return [];

  const hits = await searchLegislation(`${stem} Amendment`, { limit: 25 });

  // The repository's search is a loose full-text match, so querying
  // "Companies Amendment" happily returns the Income Tax (Amendment) Act and
  // the Civil Proceedings (Fees) (Amendment) Rules. Presenting those as
  // amendments to the Companies Act is worse than returning nothing — it is a
  // confident, wrong statement about what the law says. So require the
  // candidate to name the principal Act as well as being an amendment.
  const stemWords = significantWords(stem);
  if (stemWords.length === 0) return [];
  return hits.filter((h) => {
    if (!/amendment/i.test(h.title)) return false;
    const title = normaliseTitle(h.title);
    // Padded on both sides so matching is on whole words, not substrings.
    return stemWords.every((w) => title.includes(` ${w} `));
  });
}

/** Strip punctuation and lowercase, so titles compare on words alone. */
function normaliseTitle(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * The distinguishing words of a principal Act's short title — everything before
 * "Act"/"Law"/"Decree", with the year and any bracketed qualifier removed.
 * "National Health Insurance Act, 2003 (Act 650)" -> "national health insurance".
 */
export function principalActStem(actName: string): string {
  return actName
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(act|law|decree|instrument)\b.*$/i, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^A-Za-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Stem words that must appear in a candidate title, ignoring filler. */
export function significantWords(stem: string): string[] {
  const STOP = new Set(["the", "of", "and", "for", "a", "an", "to", "in", "on"]);
  return stem.split(" ").filter((w) => w.length > 1 && !STOP.has(w));
}

// --- text ------------------------------------------------------------------

async function resolvePdfBitstream(
  uuid: string,
): Promise<{ href: string; name: string; bytes: number } | null> {
  const bundles = await getJson<{
    _embedded?: {
      bundles?: { name?: string; _links?: { bitstreams?: { href?: string } } }[];
    };
  }>(`${ghanaLawBaseUrl()}/core/items/${uuid}/bundles`);
  const original = (bundles._embedded?.bundles ?? []).find(
    (b) => b.name === "ORIGINAL",
  );
  const href = original?._links?.bitstreams?.href;
  if (!href) return null;

  const listed = await getJson<{
    _embedded?: {
      bitstreams?: {
        name?: string;
        sizeBytes?: number;
        _links?: { content?: { href?: string } };
      }[];
    };
  }>(href);
  const streams = listed._embedded?.bitstreams ?? [];
  const pdf = streams.find((b) => /\.pdf$/i.test(b.name ?? "")) ?? streams[0];
  const content = pdf?._links?.content?.href;
  if (!pdf || !content) return null;
  return { href: content, name: pdf.name ?? "document.pdf", bytes: pdf.sizeBytes ?? 0 };
}

export async function getLegislationItem(
  uuid: string,
): Promise<LegislationItem | null> {
  try {
    const data = await getJson<{
      uuid?: string;
      name?: string;
      metadata?: Record<string, { value?: string }[]>;
    }>(`${ghanaLawBaseUrl()}/core/items/${uuid}`);
    if (!data?.uuid || !data?.name) return null;
    return toItem({ _embedded: { indexableObject: data } }, new Map());
  } catch {
    return null;
  }
}

/**
 * Cache key. OCR results are keyed by how many pages were transcribed, because
 * a partial transcription must not be served to a caller that asked for more —
 * otherwise the first small read would permanently cap the document.
 */
function cacheKey(uuid: string, ocrPages?: number): string {
  return ocrPages
    ? `${CACHE_PREFIX}/${uuid}.ocr-${ocrPages}.json`
    : `${CACHE_PREFIX}/${uuid}.json`;
}

/**
 * Fetch an item's text, extracting the attached PDF and caching the result.
 *
 * A scan is cached too — re-downloading and re-extracting a 1.6MB image PDF on
 * every ask, only to conclude again that it has no text, is pure waste.
 */
export async function fetchLegislationText(
  uuid: string,
  opts: { ocr?: { model: string; apiKeys?: UserApiKeys; maxPages?: number } } = {},
): Promise<LegislationText | null> {
  const item = await getLegislationItem(uuid);
  if (!item) return null;

  if (isStorageEnabled()) {
    try {
      // Prefer an OCR transcription covering at least what was asked for;
      // otherwise fall back to the plain extraction result.
      const wantedPages = opts.ocr
        ? Math.min(opts.ocr.maxPages ?? OCR_MAX_PAGES, OCR_MAX_PAGES)
        : 0;
      const cached =
        (wantedPages
          ? await downloadFile(cacheKey(uuid, wantedPages))
          : null) ?? (await downloadFile(cacheKey(uuid)));
      if (cached) {
        const payload = JSON.parse(
          Buffer.from(cached).toString("utf8"),
        ) as Omit<LegislationText, "item">;
        return { item, ...payload };
      }
    } catch {
      // A bad cache entry must never block a live fetch.
    }
  }

  const pdf = await resolvePdfBitstream(uuid);
  if (!pdf) {
    return { item, quality: "empty", text: "", pages: 0, chars: 0, filename: null };
  }
  if (pdf.bytes > MAX_PDF_BYTES) {
    throw new Error(
      `"${item.title}" is ${(pdf.bytes / 1e6).toFixed(1)}MB, over the ${(
        MAX_PDF_BYTES / 1e6
      ).toFixed(0)}MB limit for inline extraction.`,
    );
  }

  const res = await fetch(pdf.href, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Could not download "${pdf.name}" (${res.status}).`);
  }
  const raw = await res.arrayBuffer();
  // pdf.js takes ownership of the buffer it is handed and detaches it, so give
  // it a copy — `raw` is still needed for OCR when there turns out to be no
  // text layer.
  const text = await extractPdfText(raw.slice(0));
  const assessment = assessExtractedText(text);

  let result: LegislationText = {
    item,
    quality: assessment.quality,
    text: assessment.quality === "text" ? text : "",
    pages: assessment.pages,
    chars: assessment.chars,
    filename: pdf.name,
  };

  // No text layer, but the page images are perfectly legible to a vision model.
  // Transcribe rather than declaring the Act unreadable — flagged as "ocr" so
  // neither the model nor the reader mistakes a transcription for the authentic
  // text layer.
  if (
    assessment.quality === "scan" &&
    opts.ocr &&
    ocrAvailable() &&
    assessment.pages > 0
  ) {
    try {
      const ocr = await ocrPdfPages({
        pdf: raw,
        model: opts.ocr.model,
        totalPages: assessment.pages,
        maxPages: opts.ocr.maxPages,
        apiKeys: opts.ocr.apiKeys,
      });
      const ocrAssessment = assessExtractedText(ocr.text);
      if (ocrAssessment.quality === "text") {
        result = {
          ...result,
          quality: "ocr",
          text: ocr.text,
          chars: ocrAssessment.chars,
          ocr: { pagesRead: ocr.pagesRead, truncated: ocr.truncated },
        };
      }
    } catch (err) {
      // OCR is a best-effort improvement on "unreadable"; if it fails the
      // caller still gets the honest scan result.
      console.error("[ghanaLaw] OCR failed for", uuid, err);
    }
  }

  if (isStorageEnabled()) {
    try {
      const { item: _omit, ...payload } = result;
      await uploadFile(
        cacheKey(
          uuid,
          result.quality === "ocr"
            ? Math.min(opts.ocr?.maxPages ?? OCR_MAX_PAGES, OCR_MAX_PAGES)
            : undefined,
        ),
        new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
        "application/json",
      );
    } catch {
      // Caching is an optimisation; a failure here must not fail the read.
    }
  }

  return result;
}

/**
 * Search within one item's text. Acts run to hundreds of thousands of
 * characters — the largest observed was 783k, far past any context window — so
 * this, not whole-document reads, is the primary way the model should read a
 * long Act.
 */
export function findInLegislationText(
  text: string,
  query: string,
  opts: { maxMatches?: number; contextChars?: number } = {},
): { page: number | null; excerpt: string }[] {
  const maxMatches = Math.min(Math.max(opts.maxMatches ?? 8, 1), 25);
  const contextChars = Math.min(Math.max(opts.contextChars ?? 700, 100), 4000);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: { page: number | null; excerpt: string }[] = [];
  const hay = text.toLowerCase();
  let from = 0;
  while (matches.length < maxMatches) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    const start = Math.max(0, at - Math.floor(contextChars / 2));
    const end = Math.min(text.length, at + needle.length + Math.floor(contextChars / 2));
    // Attribute the hit to the nearest preceding [Page N] marker.
    const before = text.slice(0, at);
    const lastMarker = before.lastIndexOf("[Page ");
    const page =
      lastMarker === -1
        ? null
        : Number.parseInt(before.slice(lastMarker + 6), 10) || null;
    matches.push({
      page,
      excerpt: text.slice(start, end).replace(/\s+/g, " ").trim(),
    });
    from = at + needle.length;
  }
  return matches;
}
