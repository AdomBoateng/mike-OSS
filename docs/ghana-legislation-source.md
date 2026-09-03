# Ghana legislation: where the text comes from

The assistant can look up Ghanaian primary legislation. This page records **what
the source is, how it is accessed, what was deliberately not used, and what is
still unresolved** — the reuse question in particular. Read it before extending
the source or putting the feature in front of users.

Implementation: `backend/src/lib/ghanaLaw.ts` (client),
`backend/src/lib/legalSourcesTools/ghanaLawTools.ts` (tool schemas and prompt),
`backend/src/lib/toolSources/ghanaLawSource.ts` (registration and gating).

## The source

**Parliament of Ghana Library Repository**, which runs DSpace 9.1 and exposes an
open, unauthenticated REST API:

```
https://repository.parliament.gh/server/api
  -> {"dspaceName":"Parliament of Ghana Library Repository","dspaceVersion":"DSpace 9.1",...}
```

This is an **API integration, not scraping**. DSpace is standard institutional
repository software and `/server/api` is its documented machine-facing
interface — the same API the repository's own web UI consumes. No HTML is
parsed, no browser is driven, and no API key exists to configure, which is why
this source has no entry in `userApiKeys`.

Override the base URL with `GHANA_LAW_BASE_URL` if the repository moves.

### Endpoints used

| Call | Purpose |
| --- | --- |
| `GET /core/collections?size=200` | list collections, to resolve the legislation ones by name |
| `GET /discover/search/objects?scope=<uuid>&dsoType=item&query=...` | search **within** a legislation collection |
| `GET /core/items/<uuid>/bundles` -> bitstreams | locate the item's `ORIGINAL` PDF |
| `GET <bitstream href>` | download that PDF |

All JSON except the last. Collections are resolved **by name** rather than by
hard-coded UUID: UUIDs are instance-specific and would silently break if the
repository were rebuilt, whereas the collection names are editorial and stable.

Searches are always scoped to the legislation collections and then filtered by
title. The repository indexes Hansard, committee reports and budget papers in
the same search index, and an unscoped query returns committee reports that look
plausible and are not the law.

### After download

`pdfjs-dist` extracts the text layer. About a third of the corpus is image-only,
so when there is no text layer the pages are rasterised with `pdftoppm` and
transcribed by the multimodal model behind `CUSTOM_LLM_BASE_URL`. Every result
is classified `text` / `ocr` / `scan` / `empty` (`assessExtractedText` in
`pdfText.ts`) so a scan is reported as *unreadable* rather than *empty* — that
distinction is what stops the model substituting remembered text for a document
it could not actually read.

Extracted text is cached in the S3 bucket under `ghana-law/items/`, keyed by
item UUID (and OCR page count when transcribed), so any given Act is fetched and
extracted once. A cold fetch downloads and extracts a PDF and can take 20s+.

## Politeness and robots.txt

`https://repository.parliament.gh/robots.txt` restricts UI paths — `/search`,
`/admin/*`, `/submit`, `/workspaceitems`, `/profile`, `/workflowitems`,
`/processes` — and carries no `Disallow` covering `/server/api`.

We touch none of the disallowed paths. In particular the UI's `/search` is never
requested; searching goes to `/server/api/discover/search/objects` scoped to
specific collection UUIDs.

The system prompt tells the model to **search once** and proceed, rather than
re-running reworded queries: this is a small public service, and repeated
searching neither finds more nor is free. Requests are time-bounded
(`GHANA_LAW_REQUEST_TIMEOUT_MS`, `GHANA_LAW_DOWNLOAD_TIMEOUT_MS`) and PDFs above
`GHANA_LAW_MAX_PDF_BYTES` (25MB) are refused rather than extracted.

## Sources deliberately NOT used

**GhaLII (`ghalii.org`)** — the better-structured corpus, and excluded anyway.
Its terms prohibit scraping and bulk downloading, and its `robots.txt`
(re-verified 2026-09-01) is explicit on three counts:

- `User-agent: *` / `Disallow: /api/` — the API is closed to every agent;
- `User-agent: ClaudeBot` / `Disallow: /` — alongside GPTBot, CCBot,
  Google-Extended, Bytespider, Amazonbot, Applebot-Extended and
  meta-externalagent;
- `Content-Signal: search=yes,ai-train=no,use=reference`, which the file states
  is an express reservation of rights under Article 4 of EU Directive 2019/790.

Do not add it as a programmatic source. If richer coverage is needed, approach
AfricanLII / Laws.Africa for a licensed feed instead.

**Constitute Project** — `robots.txt` disallows `/*.json` and `/*?*key=*`,
leaving only the PDF path, which was not worth a dependency for one document.

## Reuse terms

There are two separate questions here, and only the first is settled.

### 1. Copyright in the text — settled

**Copyright Act, 2005 (Act 690), section 8 — "Public benefit works"** provides
that the rights under sections 5 and 6 do **not** vest in any person in respect
of, among other things:

- **an enactment**;
- **a decision of a court or tribunal** established for the administration of
  justice in the Republic;
- a report of a Government commission of enquiry published by Government.

So the text of a Ghanaian Act is not subject to copyright, which is the basis on
which anyone may republish it. The same provision covers **judgments**, which
matters if a case-law source is ever added — but it protects the *judgment*, not
a law report publisher's headnotes, catchwords, summaries or editorial
arrangement, which are that publisher's own original work.

Verify against the Act itself rather than against this summary.

### 2. Terms of use of this particular repository — still open

**The repository publishes no reuse licence, and no written permission has been
obtained.** Section 8 answers whether the *law* is copyrighted; it does not by
itself answer whether this service permits the way we use it — downloading its
PDFs in volume, extracting and caching the text, and serving excerpts to users.

Nothing found so far restricts it: `robots.txt` does not cover `/server/api`,
and no terms-of-use page was located. But silence is not permission, only
silence.

Before commercial or user-facing reliance, get written confirmation from the
Parliament of Ghana Library on programmatic retrieval and redistribution of the
legislation PDFs and their extracted text, and record the answer here.

## What the corpus is — and is not

These limits are enforced in the system prompt because they change what an
answer means, not merely how complete it is:

- **As enacted, not as amended.** Amendments are filed as their own items
  ("X (Amendment) Act, 2025") and are never folded into the principal Act. The
  consolidated *Revised Edition* series is image-only. Nothing here states the
  law **in force**, so the model must call `ghana_law_find_amendments` before
  relying on a provision and tell the user what it found.
- **~a third is scanned images**, and the year does not predict which — a 2025
  Act in the survey was a scan. OCR text is marked `ocr` and the model must say
  so when quoting it.
- **Subsidiary legislation is thin** (14 Legislative Instruments at the time of
  writing). A search finding nothing means the repository has no matching item —
  never that no such law exists.
- **Metadata is not always consistent**; where an attached filename disagrees
  with the item title, both get mentioned.
- **No Ghanaian case law exists in this source**, and the prompt forbids
  claiming otherwise.

## When the tools are offered

Four tools, intended to be used in this order:

| Tool | Use |
| --- | --- |
| `ghana_law_search` | find an Act by name or subject (search first; never demand an Act number up front) |
| `ghana_law_find_in` | locate provisions inside an Act — preferred, as Acts run to hundreds of thousands of characters |
| `ghana_law_read` | continuous text, paged via the returned offset |
| `ghana_law_find_amendments` | required before relying on any quoted provision |

They are offered when:

- `GHANA_LAW_ENABLED` is not `false` (instance-wide kill switch, e.g. while the
  repository is down), **and**
- the user's `user_profiles.legal_research_gh` flag is on (defaults **true**).

Per-jurisdiction flags are deliberate: `legal_research_us` (CourtListener) and
`legal_research_gh` are separate because one switch cannot express "Ghana yes,
US no". Surfaces that must stay research-free name every flag explicitly —
tabular review passes `includeGhanaLaw: false` — rather than relying on
omission, because a new source defaults to *on*.

Available in assistant chat and project chat. Not in tabular review.

### The kinds of question that reach it

The model decides from the tool descriptions, so this is indicative rather than
a rule. In practice the tools fire on questions about Ghanaian statute by name
or by subject:

- "What does the Companies Act 2019 say about directors' duties?"
- "Is there Ghanaian legislation on data protection?"
- "Has the Labour Act been amended?"
- Document-grounded questions: "Does this contract's arbitration clause comply
  with Ghana's Alternative Dispute Resolution Act?"

They do not fire for US or other foreign law (that is CourtListener), for
Ghanaian **case law** (no such source exists here), or for drafting help with no
statutory question behind it.
