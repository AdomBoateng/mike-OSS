# Self-Hosting Roadmap — Mike

Plan to move Mike off managed cloud dependencies onto self-hosted infrastructure.
Four changes, sequenced by risk. **No tradeoffs on features** — MFA and existing user
data are preserved (see decisions below).

## Locked decisions

- **Existing users must survive the migration.** User UUIDs are the ownership key
  across all rows and storage prefixes — they must be preserved, not regenerated.
  A data backfill / identity-mapping step is required (Phase 3).
- **MFA is kept and rebuilt.** Supabase AAL goes away; we rebuild TOTP against our
  own store. No dropping of MFA-on-login.

## Status

- **Phase 1 (S3/surf): code complete.** `storage.ts` reads `S3_*` with `R2_*`
  fallback; unit tests + a gated `npm run test:integration` smoke-test (verified
  live against the current R2 backend). Remaining: point `.env` at surf + browser
  CORS check.
- **Phase 2 (API registry): Steps 1–3 done.** `ToolSource` registry
  (`backend/src/lib/toolSources/`) drives tool + system-prompt assembly;
  CourtListener registered as the first source (behavior unchanged, regression
  tested); `availableProvidersFrom()` feeds real key availability into gating.
  Recipe for new sources in `docs/adding-api-sources.md`. Step 4 (a real second
  source) skipped for now; Step 5 (migrate inline dispatch into `ToolSource`)
  deferred as highest-risk.
- **Phase 3 (LDAP + Postgres): DB layer done; LDAP not started.**
  - Postgres runs via `docker-compose.yml` (host port **5433** to avoid a native
    Postgres on 5432); `schema.sql` loads unmodified via `backend/db/initdb/00-auth-shim.sql`
    (provides `auth.users` + the `anon`/`authenticated`/`service_role` roles).
  - A PostgREST-compatible query shim over `pg` lives in `backend/src/lib/db/`.
    `createServerSupabase()` now returns it (factory bridge), so all ~315
    `.from()/.rpc()` call sites use Postgres unchanged. Full backend typechecks;
    65 unit + 11 integration tests pass against the live DB (incl. real
    `userApiKeys` code paths). One embedded select rewritten (mcp/servers.ts);
    4 `db.auth.admin.*` sites moved to `getSupabaseAuthAdmin()`.
  - LDAP login core built (non-breaking, not yet wired into middleware):
    `lib/ldap.ts` (bind against FreeIPA), `lib/session.ts` (our own HS256 JWT),
    `lib/authUsers.ts` (`upsertLdapUser` keyed on `auth.users.ldap_uid`, seeds
    profile via trigger), and `POST /auth/login` (routes/auth.ts, rate-limited).
    Env in .env/.env.example (SESSION_JWT_SECRET, LDAP_*). Directory verified
    reachable — service bind + user search work (integration test); real-login
    tests skip until LDAP_TEST_USERNAME/PASSWORD set.
  - CUTOVER DONE: `requireAuth` + `getUserIdFromRequest` now verify our session
    token (`verifySession`), not Supabase. Frontend swapped: token store
    (`lib/authToken.ts`), `AuthContext` uses `POST /auth/login`, login page is
    username/password, signup redirects to login, `MfaLoginGate` is a
    pass-through, and all `supabase.auth.getSession()` token reads (7 files +
    mikeApi) now use the stored token. Verified: login endpoint 401/400; auth
    middleware rejects missing/garbage/wrong-secret tokens (401) and accepts a
    valid session token; new login form renders with no console errors. Added a
    process-level unhandledRejection/uncaughtException guard + pg pool 'error'
    handler so a DB outage degrades requests instead of crashing the server.
  - STILL REMAINING: MFA rebuild (TOTP; currently disabled). Supabase→Postgres
    user/data backfill (local DB has only seeded users). Full success-path
    verification (real LDAP login → app) needs Postgres up + a real directory
    credential. Residual Supabase imports remain only in the deprecated MFA
    pages (security, verify-mfa, MfaVerificationPopup) — off the main path.

Tests: `npm test` (backend, Node built-in runner + tsx). Integration:
`npm run test:integration` (needs a configured storage backend; auto-skips).

## Sequencing

```
Phase 1 ──► Phase 2 ──► Phase 3
  #4 S3      #3 APIs      #1 LDAP + #2 Postgres  (combined, atomic)
 config     additive       the big migration
```

Phases 1 and 2 are independent of each other and of Phase 3. Phase 3 is the only hard
dependency chain (auth and DB must move together).

---

## Current architecture (baseline)

- **Auth**: Supabase Auth only. Frontend uses `supabase.auth.*` (session, MFA, signOut,
  updateUser) in `frontend/src/contexts/AuthContext.tsx`. Backend verifies the Supabase
  JWT via `admin.auth.getUser(token)` in `backend/src/middleware/auth.ts` and
  `backend/src/lib/supabase.ts`. MFA-on-login rides on Supabase AAL (assurance levels).
- **Database**: Supabase *is* the DB, accessed through the PostgREST client
  (`.from()/.rpc()`) — **323 calls across 25 backend files**. Frontend makes **zero**
  direct DB calls; all data access goes through the backend API. Schema in
  `backend/schema.sql` + ~40 migrations, including Postgres RPC functions
  (`*_overview_rpc`).
- **Storage**: Cloudflare R2 via `@aws-sdk/client-s3` in `backend/src/lib/storage.ts` —
  already S3-compatible, configured with `R2_*` env vars, `forcePathStyle: true`.
- **External APIs**: CourtListener only — `backend/src/lib/legalSourcesTools/courtlistenerTools.ts`
  + `backend/src/lib/courtlistener.ts`, dispatched inline by tool-name inside
  `backend/src/lib/chatTools.ts`. Provider/api-key pattern already exists in
  `backend/src/lib/userApiKeys.ts` (+ a `custom` LLM provider in `backend/src/lib/llm/custom.ts`).

---

## Phase 1 — Self-hosted S3 "surf" (replaces R2)

**Effort: low (mostly config). Risk: low.**

**Scope**
- Rename/alias `R2_*` env vars → `S3_*`, keeping back-compat reads. Single file:
  `backend/src/lib/storage.ts`. Update `backend/.env.example`.
- Point `endpoint` / credentials / bucket at surf. `forcePathStyle: true` is already set.

**Must verify before done**
1. **Presigned GET URLs** work against surf (`getSignedUrl()` powers all downloads).
   If unsupported → fallback: stream through the backend (code change, medium effort).
2. **`ResponseContentDisposition`** override on presigned URLs (download filenames).
3. **CORS** on surf — browser hits signed URLs directly (`useFetchDocxBytes`, `DocxView`).
4. Upload / download / list / delete round-trip on a real document.

**Milestone:** upload a doc, open it, download it with correct filename, delete it — all
against surf.

---

## Phase 2 — Pluggable API registry (adds APIs beyond CourtListener)

**Effort: low–medium. Risk: low (additive).**

**Problem today:** CourtListener is dispatched inline by tool-name in the large
`chatTools.ts`. Copy-paste for more APIs would make that file unmaintainable.

**Scope**
1. **`ToolSource` interface** — each API module exports tool schemas, tool-name
   constants, a system-prompt fragment, and a `handle(toolName, args, ctx)` dispatcher.
   CourtListener becomes the first implementation (extract from `chatTools.ts`).
2. **Registry** — `chatTools.ts` iterates registered sources instead of hardcoding
   CourtListener (collect tools, concat prompt fragments, route calls).
3. **Key config** — extend `userApiKeys.ts` (`PROVIDERS` + `envApiKey()` + account UI)
   so each API gets a user key + env fallback.
4. **Evaluate MCP connectors** (`backend/src/lib/mcp/servers.ts`) — may cover some APIs
   with zero custom code. Decide per-API: native `ToolSource` vs MCP connector.

**Milestone:** CourtListener runs unchanged through the new registry (regression), then a
second stub API is added end-to-end (key config → tool call → rendered result).

---

## Phase 3 — LDAP auth + Postgres (combined, atomic)

**Effort: high. Risk: high.** Supabase Auth and Supabase-DB are entangled
(`user_profiles.user_id` → Supabase auth users; MFA → Supabase AAL; user UUID is the
ownership key everywhere). Move them together.

### 3a. Decisions locked
- **Identity mapping (existing users preserved):** on first successful LDAP bind, look up
  the user's existing UUID via a mapping table (`ldap_uid → uuid`) seeded from the current
  Supabase auth users during migration. **Reuse existing UUIDs** — never regenerate — so
  all FKs and storage prefixes keep working.
- **Session model:** backend issues its own signed JWT after LDAP bind; frontend sends
  `Bearer` (same header contract, so route handlers barely change).
- **MFA (kept, rebuilt):** implement TOTP enrollment + verification against our own store,
  replacing Supabase `admin.auth.mfa` / AAL. Preserve the `mfa_on_login` preference and the
  step-up (403 `mfa_verification_required`) contract so `MfaLoginGate` / verify-mfa flows
  keep working.

### 3b. Database migration (#2)
- Stand up plain Postgres; load `schema.sql` + migrations. RPC functions port directly.
- Replace the PostgREST client (`.from()/.rpc()`, 323 calls / 25 files) with a real driver
  (`pg` or `postgres.js`), behind a thin data-access helper to keep call sites readable.
- **RLS is a non-issue** — backend already uses service-role and bypasses RLS (migrations
  revoke client grants), so plain Postgres loses nothing.
- Add a `users`/auth table + `ldap_uid → uuid` mapping to replace Supabase `auth.users`.
- **Data backfill:** export existing Supabase auth users (id, email, MFA factors where
  portable) → seed the new `users` + mapping tables so existing UUIDs are retained.

### 3c. Auth swap (#1)
- **Backend:** `middleware/auth.ts` + `lib/supabase.ts` → LDAP bind + JWT verify + our MFA.
- **Frontend:** replace every `supabase.auth.*` in `AuthContext.tsx` (session,
  onAuthStateChange, signOut, updateUser) with the new LDAP login endpoint. Remove
  signup path + Supabase login path. Rebuild MFA enrollment/verify UI against new endpoints.
- Remove `@supabase/supabase-js` from both `package.json`s once green.

**Milestones (staged)**
1. Postgres cutover (DB rewrite proven in isolation if Supabase auth can temporarily point
   at the new DB; otherwise 3b+3c land together).
2. Backfill verified: an existing user's UUID, documents, and projects resolve unchanged.
3. LDAP login issues a session; protected route resolves mapped UUID; user sees only own data.
4. MFA: enroll TOTP, log out, log in, get stepped up, verify — end to end.
5. Full regression: login → upload → chat w/ CourtListener → tabular review → download.

---

## Cross-cutting risks

| Risk | Phase | Mitigation / decision |
|---|---|---|
| surf lacks presigned URLs | 1 | Fallback: stream downloads through backend |
| MFA rebuild scope | 3 | TOTP against own store; preserve step-up contract |
| Existing UUID preservation | 3 | Mapping table seeded from Supabase auth export; never regenerate |
| MFA secret migration | 3 | Supabase TOTP secrets may not be exportable → existing users may need to re-enroll MFA after cutover (confirm) |
| `chatTools.ts` size | 2 | Registry refactor is the mitigation |

## Recommended first move
Start **Phase 1** — day-scale, validates surf reachability / CORS / presigning before
committing to the larger phases.

## Open item to confirm before Phase 3
Whether existing users' **MFA secrets** can be exported from Supabase. If not, users keep
their accounts/data (UUIDs preserved) but must **re-enroll MFA** once after cutover.
