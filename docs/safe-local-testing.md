# Safe Local Testing

Test with synthetic documents until you have satisfied yourself about where data goes.
This page is about that: what leaves the box, what doesn't, and how to clean up.

Self-hosting changes the risk picture but does not remove it. Documents are processed by
*your* model endpoint, stored in *your* bucket, and held in *your* database — so the
main upstream concern, sending client material to a third-party model provider, is gone.
What remains is that a test deployment is wired to real, shared infrastructure.

## What actually leaves your infrastructure

Four egress paths, in rough order of how easy they are to forget:

- **SMTP sends real mail to real people.** Sharing a project emails every address you add
  — colleagues included. This is the easiest way to embarrass yourself while testing.
  Leave `SMTP_HOST`/`SMTP_FROM` unset and sharing still works silently, which is the right
  default for a test instance.
- **LDAP is a shared production directory.** There is no throwaway equivalent. Every login
  is a real bind against the real directory with a real person's credentials, and every
  failed attempt is visible to whoever watches it. Use your own account, and keep the
  service bind account's password out of anything you commit or paste.
- **CourtListener**, if a token is configured, receives your citations and search terms —
  not document bodies, but the queries can still reveal what a matter is about. Leave
  `COURTLISTENER_API_TOKEN` unset to disable those tools entirely.
- **MCP connectors** are per-user and can reach anything their server reaches. Whatever a
  connector's tools are handed, its operator can see. Add none while testing unless you
  control the far end.

The model endpoint (`CUSTOM_LLM_BASE_URL`) receives full document text. That is fine when
it is your vLLM box; it is not fine if you point it at a hosted OpenAI-compatible API out
of convenience. Check what that variable is set to before uploading anything real.

## Use disposable infrastructure where you can

- **Database**: a separate Postgres, not the production volume. `docker compose up -d
  postgres` gives you one on host port 5433, and `docker compose down -v` destroys it.
- **Bucket**: a separate bucket or at minimum a separate prefix — never the production one.
- **Model endpoint**: fine to share, if it is genuinely yours.
- **Directory**: not disposable. See above.

## Secrets

The frontend needs no env file and holds no secrets. It reads exactly two variables,
`NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_API_PORT`, both optional — without them the
browser derives the API URL from the page host. Anything sensitive lives in `backend/.env`,
which is server-side only.

Generate **test-only** values for the three secrets rather than copying production ones:

```bash
openssl rand -hex 32   # SESSION_JWT_SECRET, DOWNLOAD_SIGNING_SECRET, USER_API_KEYS_ENCRYPTION_SECRET
```

Two of those have consequences beyond the test box if you reuse the real ones.
`DOWNLOAD_SIGNING_SECRET` signs **non-expiring** download links, so a token minted on a
test instance keeps working against production for as long as the object exists. And
`USER_API_KEYS_ENCRYPTION_SECRET` is what stored API keys and enrolled TOTP secrets are
encrypted with — sharing it across environments means a test database leak reads
production secrets.

Leave `RAW_LLM_STREAM_LOG_DIR` unset. It writes raw model traffic — including the text of
whatever documents were in context — to unencrypted files on disk. The production startup
check warns when it is set, but nothing stops it locally.

Before committing, confirm nothing sensitive is staged:

```bash
git status --short
```

Both `backend/.env` and `frontend/.env.local` are already gitignored. Stop if either
appears anyway, or if any file with credentials in it shows up untracked.

## Test with synthetic documents

Synthetic NDAs, sample contracts, public court filings, dummy PDF/DOCX files. Do not upload
privileged, client, matter, personnel, or firm knowledge-management material until you have
checked the deployment's storage, logging, and deletion behaviour for yourself.

## Start with the non-LLM flows

You can exercise most of the app before pointing it at a model. Without
`CUSTOM_LLM_BASE_URL` the picker is empty and the assistant cannot answer, but these still
work:

- signing in against the directory
- creating projects and subfolders
- uploading synthetic documents, and downloading them back
- document versions, renames, deletion
- sharing a project (with SMTP unset, so no mail goes out)

Then point at your model endpoint and test the assistant, still with synthetic documents.

## Clean up

```bash
docker compose down -v      # stops the stack and destroys the database volume
```

Then delete the test objects from your bucket, and any local `.env` you filled with real
values.

Verify deletion rather than assuming it. Deletion here is not uniformly hard: document
versions carry a `deleted_at` column and are soft-deleted, so a row disappearing from the
UI does not mean the record or its stored object is gone. For legal-document workflows this
distinction matters — after exercising your delete flows, check the bucket directly and
confirm the objects are actually absent.
