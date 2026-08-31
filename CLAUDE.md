# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Mike is a legal document assistant: a Next.js frontend (`frontend/`) and an Express + TypeScript
backend (`backend/`). The backend is the **only** client of the database and object storage — the
browser never talks to Postgres or S3 directly; it goes through `backend` with a Bearer session token.

**This checkout is a self-hosting fork of upstream Mike.** Managed dependencies have been replaced:

| Upstream | Here |
| --- | --- |
| Supabase Auth | LDAP bind (FreeIPA) + our own HS256 JWT session |
| Supabase Postgres / PostgREST | self-hosted Postgres via a query-builder shim over `pg` |
| Cloudflare R2 | any S3-compatible endpoint (`S3_*`, with `R2_*` as fallback) |
| Supabase-hosted email | SMTP (`nodemailer`) |
| Anthropic/Gemini/OpenAI model pickers | custom OpenAI-compatible endpoint models only |

Every file under `docs/`, plus `README.md`, describes this fork and is current — the upstream
text has all been rewritten. `backend/.env.example` remains the authoritative reference for
configuration; prefer pointing at it over restating variable lists in prose, which is how the
docs drifted last time.

## Commands

```bash
npm install --prefix backend && npm install --prefix frontend

npm run dev   --prefix backend     # tsx watch, port 3001
npm run dev   --prefix frontend    # next dev, port 3000

npm run build --prefix backend     # tsc -> backend/dist
npm run build --prefix frontend    # next build (output: standalone)
npm run lint  --prefix frontend    # eslint (backend has no lint script)
```

Tests use the Node built-in runner via `tsx` (no jest/vitest):

```bash
npm test --prefix backend                 # unit only: src/**/*.test.ts
npm run test:integration --prefix backend # src/**/*.integration.ts - hits real DB/S3/LDAP
```

Single file / single test:

```bash
node --import tsx --test backend/src/lib/storage.test.ts
```

```bash
node --import tsx --test --test-name-pattern "presigned" backend/src/lib/storage.test.ts
```

`*.test.ts` are pure unit tests and always run. `*.integration.ts` load `.env` and **self-skip** when
the relevant env var is absent (`DATABASE_URL`, `S3_*`, `LDAP_TEST_USERNAME`…), so they are safe to
run anywhere. Both patterns are excluded from `tsc` in `backend/tsconfig.json`.

Full stack under Docker (Postgres + backend + frontend), per `docs/DEPLOYMENT.md`:

```bash
docker compose up -d --build
```

## Architecture

### Auth (LDAP -> our JWT)

`POST /auth/login` binds the credentials against LDAP (`lib/ldap.ts`), upserts `auth.users` keyed on
`ldap_uid` (`lib/authUsers.ts`, preserving the user's existing UUID), refreshes display name +
organisation from the directory, and signs a session JWT (`lib/session.ts`, `SESSION_JWT_SECRET`,
12h). The frontend stores it in `localStorage` (`frontend/src/lib/authToken.ts`) and sends it as a
Bearer header; `AuthContext` derives the user by decoding the token client-side.

**LDAP is the source of truth** for email, display name, and organisation — those fields are
read-only in the app (`updateEmail` deliberately throws). There is no signup; `/signup` redirects.

`middleware/auth.ts` has two guards:

- `requireAuth` — verifies the token, populates `res.locals.{userId,userEmail,ldapUid,mfaVerified}`.
- `requireMfaIfEnrolled` — step-up gate. If the user has a verified TOTP factor and this session has
  not cleared a challenge, responds **403 with `code: "mfa_verification_required"`**; the frontend
  prompts for a code, `POST /user/security/mfa/challenge` **re-mints the token** with
  `mfaVerified: true`, and the request is retried. Add this guard to any new sensitive route.

MFA state lives in `public.user_totp_factors` (`lib/mfa.ts`), secrets AES-256-GCM encrypted via
`lib/secretCrypto.ts`. `MfaLoginGate` (frontend) enforces the separate opt-in login-time gate
(`user_profiles.mfa_on_login`).

### Database access

`createServerSupabase()` in `lib/supabase.ts` is a **legacy name kept to avoid churn across ~20
files** — it returns the shim in `lib/db/`, not a Supabase client. `@supabase/supabase-js` is gone
from both apps.

`lib/db/queryBuilder.ts` reimplements the subset of the supabase-js/PostgREST API the backend uses
(`.from().select()/.eq()/.order()/.single()/.upsert()…`) on top of `pg`, so ~315 existing call sites
work unchanged. Awaiting a builder resolves to `{ data, error, count }` and **never rejects** —
always check `error`. Not supported: embedded/nested selects, `.or()`, text search. If you need one
of those, rewrite the call site (see `lib/mcp/servers.ts` for the precedent) rather than extending
the shim casually. `db.rpc()` maps to `SELECT * FROM fn(named => $1)`.

Schema: `backend/schema.sql` is the full shape for a fresh DB and is loaded **unmodified** — a
compatibility shim (`backend/db/initdb/00-auth-shim.sql`) creates the `auth` schema, `auth.users`,
and the inert `anon`/`authenticated`/`service_role` roles first so Supabase-era FKs, triggers, and
`revoke` statements resolve. For an existing DB, apply the dated files in `backend/migrations/`
(`YYYYMMDD_*.sql`, written to be re-runnable) instead of the schema file. Schema changes need both:
an entry in `migrations/` **and** the corresponding edit to `schema.sql`.

### LLM layer

`lib/llm/` is a provider adapter: callers always speak OpenAI-style tool schemas and
`{role, content}` messages; each provider module translates. Provider is inferred from the model id
prefix in `models.ts` (`claude*` / `gemini*` / `gpt-*` / `custom/`). Entry points are
`streamChatWithTools()` and `completeText()`.

Custom endpoint models are dynamic (fetched from `{CUSTOM_LLM_BASE_URL}/models`) so they cannot live
in the static lists; they are namespaced `custom/<name>` and the prefix is stripped before the call.
The frontend `ModelToggle.tsx` only *offers* the `Custom` group — the static `MODELS` arrays remain
solely so legacy stored model ids still render a label.

Display names for the endpoint's machine ids live in `CUSTOM_MODEL_LABELS` (`models.ts`) and are
applied only where the list is served (`GET /user/custom-models`). The id is what the endpoint is
called with and must never be rewritten; an unmapped id falls back to showing its raw name.

### The assistant loop

`lib/chatTools.ts` (~4.5k lines) is the core and the single biggest file: tool schemas (`TOOLS`,
`PROJECT_EXTRA_TOOLS`, `TABULAR_TOOLS`, `WORKFLOW_TOOLS`), the system prompt builder, document
context assembly, `runToolCalls()` dispatch, and `runLLMStream()`. Routes (`chat`, `projectChat`,
`tabular`) stream to the browser as SSE: `data: {json}` frames terminated by `data: [DONE]`.

The wire format is the `AssistantEvent` union (`reasoning`, `content`, `doc_read`, `doc_created`,
`doc_edited`, `doc_replicated`, case-law/MCP tool events, `error`). It is **persisted as the message
content** in `chat_messages`, so the frontend's `AssistantEvent` type
(`frontend/src/app/components/shared/types.ts`) must stay in sync with the backend's — changing a
variant is a data-format change, not just a rendering one.

DOCX editing goes through `lib/docxTrackedChanges.ts`, which writes real Word tracked changes into
the OOXML; each edit produces an `EditAnnotation` the UI can accept/reject.

### Tool sources (external APIs)

`lib/toolSources/` is a registry: each source contributes tool schemas, a system-prompt fragment, an
optional API-key provider, and a gating predicate; registration throws on duplicate ids or tool-name
collisions. Two sources: CourtListener (US case law) and `ghana-law` (Parliament of Ghana
legislation, `lib/ghanaLaw.ts`, no API key). **Follow `docs/adding-api-sources.md`** when adding one —
note that tool *dispatch* still lives inline in `chatTools.ts`, so a new source needs a dispatch
branch there too. MCP connectors are a separate path (`lib/mcp/`, per-user servers with OAuth) merged
into the tool list by `lib/mcpConnectors.ts`.

Each source gates on **its own** flag (`buildToolSourceContext`), backed by a per-jurisdiction column
(`user_profiles.legal_research_us` / `legal_research_gh`), both defaulting true. They were one boolean
while CourtListener was alone; a single switch cannot express "Ghana yes, US no". A new source
defaults to *on*, so paths that must stay research-free (e.g. tabular review) name every flag
explicitly rather than relying on omission.

The Ghana source is deliberately conservative about what it claims: legislation is **as enacted**
(amendments are separate items, and the consolidated Revised Editions are scans), about a third of
the corpus is image-only with no text layer, and searches must be scoped to the legislation
collections *and* filtered by title — the repository indexes committee reports alongside statutes.
`lib/pdfText.ts` classifies an extraction as text/scan/empty so a scan is reported as unreadable
rather than empty, which is what stops the model inventing the text.

### Storage and downloads

`lib/storage.ts` reads `S3_*` with `R2_*` fallback, path-style by default, with fail-fast connect /
request timeouts. Config is resolved **lazily** so env changes and tests take effect without
re-importing.

Files reach the browser two ways: short-lived presigned URLs, and `/download/:token` —
HMAC-signed, **non-expiring** tokens (`lib/downloadTokens.ts`, `DOWNLOAD_SIGNING_SECRET`) that encode
storage path + filename. Chat history stores the latter so links keep working and don't need S3 CORS.

### Access control

Ownership is never assumed from `user_id` alone. `lib/access.ts` (`checkProjectAccess`,
`ensureReviewAccess`, `filterAccessibleDocumentIds`) centralizes "owner OR listed in `shared_with`
(by lowercased email)" and returns `isOwner` for the operations that must stay owner-only (delete,
rename, member management). Use these helpers rather than re-implementing the join.

### Frontend conventions

- **Every** backend call goes through `frontend/src/app/lib/mikeApi.ts` (~1.2k lines). It attaches
  the token, and throws `MikeApiError` carrying `status` and `code` (that's how
  `mfa_verification_required` is detected).
- The API base is resolved at **runtime** (`src/lib/apiBase.ts`): if `NEXT_PUBLIC_API_BASE_URL` is
  unset, the browser derives `http://<page-host>:3001`. This is deliberate — one Docker image serves
  any server IP. Don't bake the URL at build time.
- App Router with a `(pages)` route group; `src/app/components/` holds feature components,
  `src/components/ui/` the primitives. Path alias `@/*` -> `src/*` in both apps.
- Backend is Prettier-formatted with 2-space indent; frontend files use 4-space indent. Match the
  file you're editing.

## Deployment shape

`docker-compose.yml` runs postgres + backend + frontend, LAN-accessible at `http://<server-ip>:3000`;
`docker-compose.prod.yml` is an **overlay** applied on top of it (`-f` both, for every subsequent
compose command) that pins CORS, drops the published Postgres port, and sets `NODE_ENV=production`.

With `NODE_ENV=production` the backend runs `assertConfig()` (`lib/config.ts`) before binding a port
and **exits** on a fatal problem — missing/placeholder/duplicated secret, no `DATABASE_URL`, no LDAP,
no S3, no `CUSTOM_LLM_BASE_URL`. Outside production the same problems only warn. When adding a new
required env var, add it there too, and decide deliberately whether it is fatal or a warning.

Note `FRONTEND_URL` is a CORS *allowlist* (possibly `*` or comma-separated), so it is not a usable
link target. Anything that needs an absolute URL — emails especially — must use `APP_PUBLIC_URL`.
**Both 3000 and 3001 must be reachable from client machines** since the browser calls the API
directly. `DATABASE_URL`, `FRONTEND_URL`, and `SOFFICE_BINARY_PATH` from `backend/.env` are
overridden by compose; everything else is used. `FRONTEND_URL` is a comma-separated CORS allowlist,
or `*` to reflect any origin (safe here because auth is Bearer, not cookie). LDAP and S3/surf are
external hosts the server must be able to route to. The backend image ships headless LibreOffice for
DOC/DOCX to PDF; locally you need LibreOffice on PATH (or `SOFFICE_BINARY_PATH`).

`GET /health` is open; `GET /health/smtp` requires auth and runs a real `transporter.verify()`
without sending mail.

## Conventions

- Per `CONTRIBUTING.md`: keep changes small and focused; update `backend/.env.example` and the
  relevant `docs/` page when changing setup or config.
- Rate limits are per-route and env-tunable (`RATE_LIMIT_*` in `src/index.ts`); a new expensive or
  auth-adjacent route should get a limiter there.
- `index.ts` installs `unhandledRejection`/`uncaughtException` handlers that log and keep serving —
  don't rely on a crash to surface a bug.
