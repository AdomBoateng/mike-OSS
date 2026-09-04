# Self-Hosting Migration — Mike

Record of moving Mike off managed cloud dependencies onto self-hosted infrastructure.
All four planned phases have landed, plus one change that wasn't in the original plan
(custom-only models). This file is now mostly a status record; the sections after
"What's left" are kept for the reasoning behind decisions that still constrain the code.

## Status: migration complete

| # | Change | State |
| --- | --- | --- |
| 1 | S3-compatible storage (replaces R2) | done |
| 2 | Pluggable API/tool-source registry | done (steps 1–3; see below) |
| 3 | Self-hosted Postgres (replaces Supabase DB) | done |
| 4 | LDAP auth + our own sessions (replaces Supabase Auth) | done |
| 5 | TOTP MFA rebuilt on our own store | done |
| 6 | Custom-endpoint models only (unplanned) | done |

`@supabase/supabase-js` is gone from both apps and no source file in either references
Supabase. The name `createServerSupabase()` survives in `backend/src/lib/supabase.ts` as a
deliberate alias — it returns the Postgres query shim, and was kept to avoid churning ~315
call sites.

### Storage

`lib/storage.ts` reads `S3_*` with `R2_*` as fallback, path-style by default, with
fail-fast connect and request timeouts. Config resolves lazily so tests and env changes
take effect without re-importing. Covered by unit tests plus a gated integration
smoke-test (`npm run test:integration`) that round-trips upload → download → presign →
delete against a real endpoint.

### Tool sources

The `ToolSource` registry (`backend/src/lib/toolSources/`) assembles tool schemas and
system-prompt fragments and gates each source on key availability; registration throws on
duplicate ids or tool-name collisions. CourtListener is registered as the first source.

Two planned steps were deliberately not taken: adding a real second source, and moving
tool *dispatch* out of `chatTools.ts`. Dispatch is still inline there, so a new source
needs a branch in that file as well as a registry entry — `docs/adding-api-sources.md`
documents both halves.

### Database

Postgres runs via `docker-compose.yml` (host port **5433**, to avoid colliding with a
native Postgres on 5432). `backend/schema.sql` loads **unmodified**: an init script,
`backend/db/initdb/00-auth-shim.sql`, first creates the `auth` schema, `auth.users`, and
inert `anon`/`authenticated`/`service_role` roles, so the Supabase-era foreign keys,
triggers, and `revoke` statements all resolve.

`backend/src/lib/db/queryBuilder.ts` reimplements the subset of the supabase-js/PostgREST
API the backend actually used, over `pg`. Awaiting a builder resolves to
`{ data, error, count }` and never rejects, so every call site keeps its existing
error-handling shape. Not supported: embedded/nested selects, `.or()`, text search — the
one embedded select in the codebase was rewritten at its call site (`lib/mcp/servers.ts`).

RLS was a non-issue: the backend was always the sole DB client using a service role, and
the migrations revoke client grants outright.

### Auth

`POST /auth/login` binds against LDAP, upserts `auth.users` keyed on `ldap_uid`
**preserving any existing UUID**, refreshes display name and organisation from the
directory, registers a revocable 12-hour session in PostgreSQL, and signs an HS256 JWT
carrying that session id. The browser receives it in a Secure/HttpOnly/SameSite cookie;
unsafe requests use double-submit CSRF protection. A one-time bridge exchanges and deletes
sessions created by the previous localStorage/Bearer release.

LDAP is the source of truth for email, display name, and organisation; all three are
read-only in the app. There is no signup path; `/signup` redirects to login.

### MFA

Rebuilt against `public.user_totp_factors`, secrets AES-256-GCM encrypted via
`lib/secretCrypto.ts`. Both contracts from the Supabase era are preserved: the
`mfa_on_login` preference, and step-up as a 403 carrying `code: "mfa_verification_required"`
— so `MfaLoginGate` and the verify-mfa flow work as they did. A successful challenge
rotates the session cookie with `mfaVerified: true`. `requireMfaIfEnrolled` guards
sensitive routes.

The open question from the original plan — whether Supabase TOTP secrets could be exported
— was resolved by not needing an answer: there were no production users to carry over.
Anyone enrolled before the cutover re-enrols.

### Models

Not in the original plan. The Anthropic/Google/OpenAI pickers were removed in favour of a
self-hosted OpenAI-compatible endpoint. `MODELS` in `ModelToggle.tsx` and the static lists
in `llm/models.ts` are retained **only** so legacy stored model ids still render a label;
the picker offers the `Custom` group alone. The provider adapter still contains working
claude/gemini/openai modules, and their env keys are still read, so a stored legacy id
resolves rather than erroring.

## What's left

- **Browser CORS against the S3 endpoint.** Node integration tests can't verify it. Signed
  URLs are fetched directly by the browser (`useFetchDocxBytes`, `DocxView`), so confirm
  from a real browser session.
- **Drop `@supabase/auth-js`.** Still listed in `frontend/package.json` with zero imports
  anywhere in `src/` — dead weight in the lockfile.
- **Data backfill is moot, not done.** No Supabase export was ever imported; the identity
  mapping below describes a path that wasn't exercised because there was nothing to carry
  over. If that changes, the UUID-preserving upsert in `lib/authUsers.ts` is the hook.
- **Production hardening** is tracked separately in `docs/DEPLOYMENT.md`, not here.

Tests: `npm test --prefix backend` (132 unit tests, Node built-in runner + tsx).
Integration: `npm run test:integration --prefix backend` — needs a configured DB / storage /
directory and auto-skips whatever isn't there.

---

## Decisions that still constrain the code

Kept from the original plan because the code still depends on them.

- **User UUIDs are the ownership key** across every table and storage prefix. They are
  reused, never regenerated — which is why `upsertLdapUser` keys on `ldap_uid` and
  preserves an existing row's id.
- **MFA was kept, not dropped.** Rebuilding TOTP was chosen over losing the feature or
  weakening the login gate.
- **Auth and DB had to move together.** `user_profiles.user_id` referenced Supabase auth
  users and MFA rode on Supabase AAL, so splitting the two migrations wasn't possible.
- **Sessions are our own JWT, not a Supabase token**, held in an HttpOnly cookie and backed by
  `public.user_sessions` for cluster-wide logout and revocation. Bearer input remains a temporary
  migration compatibility path, not the browser's steady-state storage.

## Original sequencing

```
Phase 1 ──► Phase 2 ──► Phase 3
  S3         APIs        LDAP + Postgres  (combined, atomic)
 config    additive      the big migration
```

Phases 1 and 2 were independent of each other and of Phase 3; Phase 3 was the only hard
dependency chain. Phase 1 went first as the cheapest way to validate endpoint
reachability, CORS, and presigning before committing to the larger work.
