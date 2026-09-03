# Mike — self-hosted

Mike is a legal document assistant: a Next.js frontend, an Express + TypeScript backend,
and an assistant that reads, drafts, and edits DOCX/PDF documents with real Word tracked
changes.

**This is a self-hosting fork.** Upstream Mike ([mikeoss.com](https://mikeoss.com)) runs on
managed services; this checkout replaces every one of them with infrastructure you operate:

| Upstream | Here |
| --- | --- |
| Supabase Auth | LDAP bind (FreeIPA) + our own HS256 JWT session |
| Supabase Postgres / PostgREST | self-hosted Postgres, via a query-builder shim over `pg` |
| Cloudflare R2 | any S3-compatible endpoint |
| Supabase-hosted email | your own SMTP server |
| Anthropic / Gemini / OpenAI | a self-hosted OpenAI-compatible endpoint (vLLM) |

There is **no signup** — accounts come from the directory. If you want the managed-service
version, use upstream rather than this fork.

## Contents

- `frontend/` — Next.js application
- `backend/` — Express API, document processing, and the database schema
- `backend/schema.sql` — full schema for a fresh database
- `backend/migrations/` — dated incremental migrations for an existing database
- `docs/DEPLOYMENT.md` — Docker deployment and the production checklist
- `docs/KUBERNETES.md` — deploying to Kubernetes (UAT and production), and the GitLab pipeline that does it
- `k8s/` — kustomize manifests for those two environments
- `docs/self-hosting-roadmap.md` — what was migrated off the managed services, and what's left
- `docs/adding-api-sources.md` — how to add another external API as assistant tools
- `docs/ghana-legislation-source.md` — where the Ghana legislation text comes from, how it is accessed, and its limits

## Prerequisites

- Node.js 20 or newer, npm, git
- Docker + Compose (the supported way to run the stack)
- An LDAP directory the server can reach (developed against FreeIPA)
- An S3-compatible bucket (self-hosted MinIO/Ceph, AWS S3, or R2)
- An OpenAI-compatible model endpoint — vLLM, Ollama, LM Studio, TGI
- LibreOffice, for DOC/DOCX → PDF conversion, and poppler-utils (`pdftoppm`) for OCR of scanned
  legislation — both bundled in the backend image; install locally for `npm run dev`
- Optional: an SMTP server for collaborator invitations
- Optional: a CourtListener API token for US case-law lookup

## Configure

Everything is driven by one file:

```bash
cp backend/.env.example backend/.env
$EDITOR backend/.env
```

`backend/.env.example` is the reference — it documents every variable, which are required,
and which only disable a feature when absent. The essentials:

- **Three secrets**, each a different random value (`openssl rand -hex 32`):
  `SESSION_JWT_SECRET`, `DOWNLOAD_SIGNING_SECRET`, `USER_API_KEYS_ENCRYPTION_SECRET`
- **`DATABASE_URL`** — overridden by compose for the container network
- **`LDAP_*`** — directory URL, a service bind account, and the user base DN
- **`S3_*`** — endpoint, credentials, bucket (legacy `R2_*` names still work)
- **`CUSTOM_LLM_BASE_URL`** / **`CUSTOM_LLM_API_KEY`** — your model endpoint
- **`APP_PUBLIC_URL`** — the address users browse to, used for links in email
- **`SMTP_*`** — optional; without it, sharing still works but sends no invitation

With `NODE_ENV=production` the backend validates all of this at startup and **exits** if
something required is missing, still holds a placeholder, or reuses another secret's value.
Outside production the same problems are printed as warnings, so a partial local setup runs.

The frontend needs no env file. It derives the API URL from the page host at runtime, so one
build serves any server address; set `NEXT_PUBLIC_API_BASE_URL` only to pin a fixed backend.

## Run

```bash
docker compose up -d --build
```

Open `http://<server-ip>:3000` and sign in with directory credentials. **Both 3000 and 3001
must be reachable from client machines** — the browser calls the API directly.

On first start, an empty Postgres volume loads `backend/db/initdb/00-auth-shim.sql` (which
recreates the `auth.users` table and roles the Supabase-era schema expects) and then
`backend/schema.sql`, unmodified. For an existing database, don't run the schema file — apply
the dated files in `backend/migrations/` in filename order instead.

For production, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): it adds a compose overlay that
locks CORS, unpublishes the Postgres port, and takes the DB password from the environment,
plus a pre-flight checklist covering TLS, backups, and secret rotation.

## Develop

```bash
npm install --prefix backend && npm install --prefix frontend

npm run dev   --prefix backend     # port 3001
npm run dev   --prefix frontend    # port 3000
```

Postgres still has to be running — `docker compose up -d postgres` gives you one on host
port 5433, matching the `DATABASE_URL` in `.env.example`.

```bash
npm run build --prefix backend     # tsc -> backend/dist
npm run build --prefix frontend    # next build
npm run lint  --prefix frontend
```

Tests use the Node built-in runner via `tsx`:

```bash
npm test --prefix backend                 # unit tests, always safe to run
npm run test:integration --prefix backend # hits a real DB / S3 / LDAP
```

Integration tests load `.env` and skip themselves when the relevant variable is absent, so
they're safe to run anywhere. A single file:

```bash
node --import tsx --test backend/src/lib/storage.test.ts
```

## Models

Models come from `{CUSTOM_LLM_BASE_URL}/models` — nothing is hardcoded, so whatever your
endpoint serves is what the picker offers. Ids are namespaced `custom/<id>` internally and
the prefix is stripped before the endpoint is called.

Display names for known ids are mapped in `backend/src/lib/llm/models.ts`; an unmapped model
still appears, labelled with its raw id. A base URL and key can also be set per account under
**Account > Models & API Keys**, which overrides the instance-wide value.

## Legal research

The assistant can research two jurisdictions. Each is a separate per-user toggle under
**Account > Features > Legal Research**, both on by default, and each can be turned off without
affecting the other.

### Ghana legislation

Acts, and to a lesser extent Instruments and older Decrees, from the
[Parliament of Ghana Library Repository](https://repository.parliament.gh/). The API is open, so
nothing needs configuring — set `GHANA_LAW_ENABLED=false` to switch it off instance-wide.

Know what it is before relying on it:

- Text is **as enacted**. Amendments are separate Acts and are not folded in; the consolidated
  "Revised Edition" series is scanned images. The assistant surfaces the amendment chain and says
  the text may have changed, but nothing here states the law in force.
- Roughly a third of the collection is scanned with no machine-readable text, and the year does not
  predict which. Those pages are rasterised and transcribed by the multimodal model, and the result
  is marked as **OCR** — accurate but not authoritative, and to be checked against the original
  before it is relied on. Only the first pages of a long scan are transcribed per request. Anything
  that cannot be transcribed at all is reported as unreadable rather than as empty.
- Coverage of subsidiary legislation is thin (a handful of Legislative Instruments), so a search
  finding nothing does not mean no such law exists.
- There is **no Ghanaian case law** source. Legislation only.

Extracted text is cached in the S3 bucket under `ghana-law/items/`. A cold fetch downloads and
extracts a PDF and can take 20 seconds, so storage being configured matters more here than
elsewhere.

### CourtListener (optional)

US case law: verify citations, fetch cases, and search opinions through CourtListener. Set
`COURTLISTENER_API_TOKEN` in `backend/.env` and restart, or let users add their own token
under **Account > Models & API Keys**. Fresh databases already include the supporting tables.

Bulk data is optional. With `COURTLISTENER_BULK_DATA_ENABLED=true`, Mike reads locally
imported citation and cluster tables plus cached opinion JSON in object storage before
falling back to the live API. Leave it `false` if you haven't imported anything.

## Troubleshooting

**The backend container restart-loops.** Read its logs first: with `NODE_ENV=production` the
startup check prints `[config] ERROR` lines naming exactly which variable is missing or
invalid before it exits.

**Nobody can sign in.** The backend must be able to reach the LDAP host, and the service bind
account must be able to search `LDAP_USER_BASE_DN`. `npm run test:integration --prefix backend`
exercises the bind and search directly.

**The model picker is empty.** The backend can't reach `CUSTOM_LLM_BASE_URL`. From inside the
container, since `localhost` there is not your host:
`docker compose exec backend node -e "fetch(process.env.CUSTOM_LLM_BASE_URL+'/models').then(r=>console.log(r.status))"`

**Invitation emails never arrive.** Sign in, then call `GET /health/smtp` — it runs a real
handshake and reports the failure without sending mail. If links in delivered mail look
wrong, set `APP_PUBLIC_URL`; `FRONTEND_URL` is a CORS allowlist and can't serve as a link.

**DOC or DOCX conversion fails.** The backend image ships LibreOffice. Running outside Docker,
put `soffice` on `PATH` or set `SOFFICE_BINARY_PATH`.

## Licence

AGPL-3.0-only, as upstream. See [LICENSE](LICENSE) and [CONTRIBUTING.md](CONTRIBUTING.md).
