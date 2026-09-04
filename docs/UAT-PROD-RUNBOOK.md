# UAT and production deployment runbook

For whoever runs the pipeline. [KUBERNETES.md](KUBERNETES.md) explains *why* the
manifests are shaped as they are; this page is the ordered list of things to do,
with the checks that catch a bad step before users do.

Steps 1–7 are one-time per environment. Steps 8 onward are the deploy itself.

---

## Step 0 — What is already done

Don't redo these.

- `main` on GitLab carries the full application, the `k8s/` manifests and
  `.gitlab-ci.yml`.
- The pipeline's `test` stage passes on `main`: `backend:test` (289 unit tests)
  and `frontend:build` are both green. `frontend:lint` fails and is
  `allow_failure: true` on purpose — see [Appendix A](#appendix-a--known-issues).
- `secret_detection` passes.
- GitLab runners exist and work. They run inside Kubernetes (the job logs show
  CoreDNS at `10.96.0.10`).

## Step 1 — Fix the container registry (blocks everything else)

**Nothing can deploy until this is done.** `build:backend` and `build:frontend`
fail on `main` today, and `deploy:uat` is therefore skipped. The exact error:

```
pushing: --destination registry.quantumgroupgh.com/thequantumgroup/ai-team/mike-oss/backend:37697bd1
error checking push permissions ... dial tcp: lookup registry.quantumgroupgh.com
on 10.96.0.10:53: no such host
```

So GitLab is configured with `$CI_REGISTRY = registry.quantumgroupgh.com`, but
that name does not resolve — not from the runner's cluster DNS, and not from
outside either (checked). One of these is true, and which one changes the fix:

| If | Then |
| --- | --- |
| The registry is enabled but has no DNS record | Add the A record, and make sure the runner's DNS can resolve it |
| The registry is enabled and internal-only | Add it to CoreDNS, or give the runner a resolver that sees it |
| The registry was never enabled | Enable it in the GitLab instance config, or point the pipeline at another registry |

If you use a registry that is **not** GitLab's, override two variables at the
project level and the pipeline needs no edit:

```
BACKEND_IMAGE   = <your-registry>/mike/backend
FRONTEND_IMAGE  = <your-registry>/mike/frontend
```

and replace the `before_script` auth block in the `.kaniko` template with
credentials for that registry.

**Check:** re-run the `main` pipeline. `build:backend` and `build:frontend` must
go green before continuing. Everything below assumes images exist.

## Step 2 — Provision what lives outside the cluster

Five things, none of which the manifests create. Per environment.

1. **Postgres database + owning role.** Empty is expected — the migration Job
   builds the schema. On a fresh database that role must be able to create a
   schema (`auth`), install `pgcrypto`, and create roles: `schema.sql` is loaded
   unmodified and still ends with `revoke … from anon, authenticated`, so those
   Supabase-era roles must exist as inert `NOLOGIN` roles for it to load at all.
2. **A bucket on surf/S3, and a key pair scoped to it.** Use a *different*
   bucket for UAT than for production. A UAT test that deletes a document must
   not be able to reach a real one.
3. **Network routes from the pod network** to Postgres, surf/S3, LDAP, the vLLM
   endpoint and SMTP. All five are external. The backend proves it can reach S3
   and LDAP *before* it binds a port, so a missing route shows up as a pod that
   never becomes ready with the reason in its logs — not as a mystery failure on
   someone's first upload.
4. **DNS** for the hostname you will put in the overlay — **one** hostname per
   environment. See [Appendix D](#appendix-d--cookie-authentication) before
   considering a separate API hostname; browser auth now makes that impossible,
   not merely inconvenient.
5. **A TLS certificate** as a Secret in the namespace (`mike-uat-tls` /
   `mike-prod-tls`), or cert-manager configured to issue it. **HTTPS is now
   mandatory, including in UAT.** In production the session cookie is issued
   with the `__Host-` prefix, which the browser refuses over plain HTTP — so an
   HTTP deployment does not degrade, it fails: login appears to succeed and the
   very next request is unauthenticated.

**Check:** from a debug pod in the target namespace, confirm all five are
reachable — `nc -vz <ldap-host> 389`, `curl -sI <s3-endpoint>`,
`psql "$DATABASE_URL" -c 'select 1'`, `curl -s <vllm>/v1/models`, `nc -vz <smtp> 587`.

## Step 3 — Generate fresh credentials

Generate every one of these **separately, per environment**. Never copy a value
from UAT to production.

```bash
openssl rand -hex 32    # run three times
```

| Variable | What it does | What rotating it breaks |
| --- | --- | --- |
| `SESSION_JWT_SECRET` | signs the session JWT carried in the HttpOnly cookie | signs everyone out |
| `USER_API_KEYS_ENCRYPTION_SECRET` | AES-256-GCM for stored API keys and TOTP secrets | stored keys unreadable; **every user must re-enrol MFA** |
| `DOWNLOAD_SIGNING_SECRET` | HMAC for `/download/:token` | every download link ever put in a chat transcript, because those tokens do not expire |

**Sharing `SESSION_JWT_SECRET` between UAT and production means a UAT session
token is accepted by production.** That is the one that matters most. Sessions
are now also registered in `public.user_sessions`, so a stolen or stale token
can be revoked centrally — but only within the environment that issued it. The
shared-secret hole is not closed by the registry.

The remaining credentials come from the services in Step 2:
`DATABASE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`LDAP_SEARCH_BIND_PASSWORD`, `SMTP_PASS`, `CUSTOM_LLM_API_KEY`.

`backend/.env.example` is the authoritative list of every variable and what it
means. `k8s/secret.example.yaml` lists which of them are secret and therefore
belong in `mike-secrets` rather than the ConfigMap.

## Step 4 — Rotate what is already exposed

Do this before production carries real client data. These are not hypothetical.

1. **The LDAP search bind password.** `LDAP Authentication Backend for
   Guacamole.txt` holds directory bind credentials. It is gitignored and was
   never committed, but it has been sitting in a working directory in plain
   text. Rotate the bind account's password and update
   `LDAP_SEARCH_BIND_PASSWORD` wherever it is set.
2. **Everything currently in `backend/.env` on the dev machine.** Those values
   were rendered in full by a `docker compose config` run during development.
   Treat the whole file as disclosed: new Postgres password, new S3 key pair,
   new SMTP password, new `CUSTOM_LLM_API_KEY`, and the three secrets from
   Step 3 regenerated.
3. **The `gboateng` test account password.** It was shared in plain text during
   development. Change it in the directory.
4. **The throwaway SearXNG instance.** `mike-searxng-test` is still running on
   port 8088 of the dev machine with the secret `testsecret`, and `backend/.env`
   still points `SEARXNG_BASE_URL` at it. Stop the container and point the
   variable at the in-cluster Service (Step 10) or unset it.

**Check:** nothing in the production Secret should share a value with anything
in `backend/.env` on a developer machine.

## Step 5 — Create the namespaces and Secrets

The namespace comes from the overlay:

```bash
kubectl apply -k k8s/overlays/uat
```

The Secret is created out of band, and deliberately not managed by CI — keeping
it out of the pipeline means a compromised runner cannot read the directory bind
password out of a job log. The intended route is straight from an env file, so
there is one list of variables rather than two that drift:

```bash
kubectl -n mike-uat create secret generic mike-secrets --from-env-file=backend/.env.uat
```

Use `backend/.env.uat` and `backend/.env.prod` for these files specifically:
`backend/.gitignore` ignores `.env*` there, so a file of live credentials
cannot be committed by accident. A name like `uat.env` at the repo root matches
no ignore pattern and can be.

If the cluster has SealedSecrets or External Secrets, use it instead — an
encrypted SealedSecret can live in the repo; a plain Secret cannot.

**Check:**

```bash
kubectl -n mike-uat get secret mike-secrets -o jsonpath='{.data}' | tr ',' '\n' | wc -l
```

Compare the count against `k8s/secret.example.yaml`. A missing key surfaces
later as a pod that refuses to start, which is the design, but it is cheaper to
catch here.

## Step 6 — Set the CI/CD variables

Project → Settings → CI/CD → Variables:

| Variable | Value | Flags |
| --- | --- | --- |
| `KUBE_CONFIG_UAT` | base64 of a kubeconfig scoped to `mike-uat` | Masked |
| `KUBE_CONFIG_PROD` | base64 of a kubeconfig scoped to `mike-prod` | Masked, **Protected** |

```bash
base64 -w0 < kubeconfig-uat
```

Scope each kubeconfig to its own namespace with a ServiceAccount and Role.
A cluster-admin kubeconfig in a CI variable makes the runner the most privileged
thing in the estate.

Mark `KUBE_CONFIG_PROD` **Protected** so it is only exposed to protected
branches and tags — that is what keeps a feature branch from reaching production.

## Step 7 — Check the nodes for the Docker subnet collision

Docker's default bridge pool (`172.17`–`172.31`) overlaps both the LDAP
(`172.18.x`) and storage (`172.20.x`) subnets. On a node running Docker beside
the kubelet, an unrelated container network can silently blackhole either one for
everything on that host. This has already happened once on this project and cost
a day; it presents as a firewall problem and is not one.

```bash
docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

If anything sits in `172.18.x` or `172.20.x`, apply `default-address-pools` in
`/etc/docker/daemon.json` per
[DEPLOYMENT.md](DEPLOYMENT.md#docker-subnet-collisions-read-this-before-blaming-the-firewall)
and restart Docker.

## Step 8 — Set the hostnames, then deploy UAT

Edit `k8s/overlays/uat/kustomization.yaml` — the hostname there is a placeholder
(`mike-uat.quantumgroupgh.com`). It appears in three places in the patch: the
ingress host, the TLS block, and `APP_PUBLIC_URL`/`FRONTEND_URL`. Commit that
change; the pipeline deploys from the repo, not from a local edit.

**Dry-run the migration first, once, by hand.** The Job is safe to re-run, but a
first look at what it intends to do on a brand-new database is worth the two
minutes:

```bash
kubectl -n mike-uat run migrate-dryrun --rm -it --restart=Never \
  --image=<registry>/mike/backend:<sha> \
  --overrides='{"spec":{"containers":[{"name":"migrate-dryrun","image":"<registry>/mike/backend:<sha>","command":["node","dist/scripts/migrate.js","--dry-run"],"envFrom":[{"secretRef":{"name":"mike-secrets"}}]}]}}'
```

Expect `no public.user_profiles — treating this as a fresh database`. If it says
that about a database you believe already has data, **stop** — you are pointed at
the wrong `DATABASE_URL`.

Then merge to `main` and let `deploy:uat` run, or do it by hand in the same
order the pipeline uses:

```bash
kubectl -n mike-uat delete job mike-migrate --ignore-not-found --wait=true
kubectl apply -k k8s/overlays/uat/migrate
kubectl -n mike-uat wait --for=condition=complete job/mike-migrate --timeout=600s
kubectl apply -k k8s/overlays/uat
kubectl -n mike-uat rollout status deployment/mike-backend --timeout=900s
```

The migration must finish before the Deployments roll. That ordering is the
whole reason the Job lives in its own kustomization.

## Step 9 — Verify UAT

Machine checks:

```bash
kubectl -n mike-uat get pods
kubectl -n mike-uat logs deployment/mike-backend --tail=50   # startup probe results
curl -sS https://mike-uat.<host>/api/health                  # {"ok":true}
curl -sS https://mike-uat.<host>/api/health/ready             # {"ok":true} = database reachable
curl -sS https://mike-uat.<host>/env.js                       # window.__MIKE_API_BASE__="/api"
curl -sS https://mike-uat.<host>/api/auth/session              # 401 with no cookie — this is correct
```

That last 401 is the expected answer for a visitor with no session, not a
fault. The browser makes the same call on every page load to rehydrate, so a
401 in the console on the login page is normal.

Then, in a browser, in this order — each one proves a different external
dependency, and they fail independently:

1. **Sign in**, then open devtools → Application → Cookies. Proves the LDAP
   bind, the session registry and the cookie chain. You must see
   **`__Host-mike_session`** (HttpOnly, Secure) and `mike_csrf`. If sign-in
   succeeds but the next request is unauthenticated, the browser rejected the
   cookie — see [Appendix D](#appendix-d--cookie-authentication).
2. **Upload a document.** Proves surf/S3 write and the presigned URL path.
3. **Download it again.** Proves `DOWNLOAD_SIGNING_SECRET` and the token path.
4. **Ask the assistant something that streams for several minutes** — a redraft
   of a real contract is the honest test. Proves the vLLM route, the ingress
   read timeout and that response buffering is off.
5. **Share a project with a colleague.** Proves SMTP. `GET /api/health/smtp`
   also runs a real `transporter.verify()` without sending mail, but needs a
   session.

**Step 4 is the one people skip and the one that fails.** If the answer stops
mid-sentence after about a minute, or arrives all at once at the end instead of
streaming, the ingress annotations did not take. See
[Appendix B](#appendix-b--the-streaming-annotations).

## Step 10 — SearXNG (optional)

Open-web search is off unless `SEARXNG_BASE_URL` is set, and there is no public
fallback on purpose — falling back would send the firm's queries to a third
party, which is the whole reason for self-hosting it.

```bash
kubectl -n mike-uat create secret generic searxng-secret \
  --from-literal=SEARXNG_SECRET="$(openssl rand -hex 32)"
kubectl -n mike-uat apply -k k8s/searxng
```

Then uncomment `SEARXNG_BASE_URL` in `k8s/base/configmap.yaml` and re-apply.

`SEARXNG_SECRET` is required, not optional: the image only generates a random
key when `settings.yml` is absent, and the ConfigMap supplies one — so without
the env var the instance runs on a placeholder committed to this repo.

**Do not put an Ingress in front of it.** An open SearXNG is an open proxy.
`k8s/searxng/networkpolicy.yaml` narrows it to the backend pods, but only if the
CNI enforces NetworkPolicy — confirm that before trusting it.

**Check:** `curl -s "http://searxng:8080/search?q=test&format=json"` from a pod
in the namespace should return JSON, not a 403. A 403 means the JSON format did
not take.

## Step 11 — Production

Same as UAT, with four differences:

1. Everything in Steps 2–5 again, with **new** values. Nothing shared.
2. Hostname in `k8s/overlays/prod/kustomization.yaml`.
3. Production deploys from a **tag**, and the job is still manual:
   ```bash
   git tag -a v1.0.0 -m "First production release"
   git push gitlab v1.0.0
   ```
   Then run `deploy:prod` from the pipeline view. A production deploy should name
   a version somebody decided to ship, not whatever last merged.
4. Two replicas each and PodDisruptionBudgets are already set in that overlay.

Before the first production deploy, confirm the UAT instance has been through a
full working day with real users. The startup probes mean a misconfigured
production deploy refuses to start rather than serving a broken app, but that is
a safety net, not a test plan.

## Rollback

Images are tagged with the commit SHA so there is something to name:

```bash
kubectl -n mike-prod set image deployment/mike-backend backend=<registry>/mike/backend:<sha>
kubectl -n mike-prod set image deployment/mike-frontend frontend=<registry>/mike/frontend:<sha>
```

This rolls back **code, not schema**, and that is deliberate: an automatic
down-migration in production destroys data faster than it fixes anything. A
migration that has to be undone gets a new forward migration that undoes it.

---

## Appendix A — Known issues

**`frontend:lint` fails, by design, for now.** 41 pre-existing eslint errors, all
predating the deployment work: 25 `react-hooks/set-state-in-effect` across ~20
components, 8 `no-explicit-any`, 4 unescaped entities, 2 `require()` imports in a
build script, and two that look like real defects —
`shared/DocView.tsx:284` reads a variable before it is declared, and
`workflows/WFColumnViewModal.tsx:35` creates a component during render so its
state resets on every parent render. The job is `allow_failure: true` so the
backlog stays visible in every pipeline instead of being hidden by deleting the
job. Clear it, then remove that flag.

**Runner build times.** `backend:test` took 621s and `frontend:build` 759s on the
first run, against ~9s and ~40s locally. The `.node` cache in `.gitlab-ci.yml`
keys on the lockfiles and should cut most of that on subsequent runs. If it does
not, check that the runner has a cache backend configured at all.

## Appendix B — The streaming annotations

Three ingress annotations in `k8s/base/ingress.yaml` are not optional:

```yaml
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-buffering: "off"
```

The assistant answers over Server-Sent Events and a single answer can run past
ten minutes — a full contract redraft measured 10m40s in testing. nginx's
defaults kill that at 60 seconds and the user sees an answer that stops
mid-sentence. Buffering defeats streaming outright: nginx holds the whole answer
and delivers it in one lump at the end.

`proxy-body-size: 110m` matters too — the app caps uploads at 100MB and nginx's
1MB default rejects any real document with a 413 before the app sees it.

**If you use a controller other than nginx, these have equivalents and you must
set them.** This is the single most likely way a deploy that "works" is unusable.

The ingress must also **pass `Cookie`, `Set-Cookie` and the `X-CSRF-Token`
header through untouched**, and preserve the original `Host` and
`X-Forwarded-Proto`. nginx-ingress does all of this by default; a proxy in front
of it configured to strip or rewrite headers will break authentication in a way
that looks like an application bug. See
[Appendix D](#appendix-d--cookie-authentication).

## Appendix C — What is deliberately not automated

- **Secrets** are never created by CI. A compromised runner should not be able to
  read the directory bind password from a job log.
- **Down-migrations** do not exist. See [Rollback](#rollback).
- **Production deploys** are manual and tag-only.
- **`deploy:uat` runs on every merge to `main`.** If that is too eager for your
  release process, change the rule in `.gitlab-ci.yml` to require a tag as
  production does.

## Appendix D — Cookie authentication

Browser sessions moved from a `localStorage` Bearer token to a revocable
HttpOnly cookie. Four consequences for deployment, none of them optional.

**One hostname is now required, not preferred.** In production the session
cookie is named `__Host-mike_session`. That prefix is enforced by the browser:
the cookie must be `Secure`, path `/`, and carry **no `Domain` attribute** —
which makes it host-only and impossible to share across subdomains. A separate
`mike-api.<host>` would simply never receive it. The `/api` path-routing in
`k8s/base/ingress.yaml` is what makes this work; do not split it.

**HTTPS is required, including in UAT.** `cookiesAreSecure()` returns true
whenever `NODE_ENV=production`, so the cookie is issued `Secure` and a browser
on plain HTTP silently discards it. The symptom is specific and misleading:
login returns 200, then every subsequent request is unauthenticated. There is a
`COOKIE_SECURE=false` escape hatch for local work — **never set it in a
deployed environment**; it turns the session cookie into one any network
observer can lift.

**`FRONTEND_URL` must be exact origins.** Production now *refuses to start* if
it is missing, wildcard, malformed, or path-bearing (`lib/config.ts`). `"*"` was
acceptable when auth was a Bearer header; with ambient cookies it would let any
site drive an authenticated session. The overlays already set it to the single
public origin — keep it that way.

**Unsafe requests need CSRF.** A second cookie, `mike_csrf`, is issued
alongside, and non-GET requests must echo it in an `X-CSRF-Token` header. The
frontend does this itself; it matters here only in that no proxy may strip that
header.

### The new table

Sessions live in `public.user_sessions`, added by
`backend/migrations/20260904_user_sessions.sql`. Logout revokes the row, so it
takes effect across every replica rather than only the pod that served the
request — which is why revocation works at all with two backend replicas.

A database that does not have this table produces **HTTP 503 "Authentication
service unavailable"** on every login attempt. LDAP is fine, the password is
fine, and the log line is `[auth/login] failed to create session`. This is the
normal symptom of deploying the new code against a database that was not
migrated. It was hit on the development database during this work.

**Do not reach for `--baseline` to fix it.** `--baseline` records every
migration as applied *without running any of them*, so on a database that is
genuinely behind it writes down a lie and the missing table stays missing. It is
only for a database already current with the build. When a database is behind
and has no ledger, create `public.schema_migrations` and insert only the
filenames it really has had, then run the migration normally so it applies the
remainder. That is the second branch in
[KUBERNETES.md](KUBERNETES.md#the-database), and it is the branch the
development database needed: it was three migrations behind
(`20260902_documents_overview_rpc`, `20260903_02_tabular_model_drop_gemini_default`,
`20260904_user_sessions`) with no ledger at all. `--dry-run` names exactly what
would be applied and changes nothing, so run it first.

`ALLOW_BEARER_TOKEN_RESPONSE` is set to `"false"` in `k8s/base/configmap.yaml`
and should stay there. Bearer headers are still *accepted* so pre-migration
sessions can exchange themselves at `/api/auth/session`, but the login response
no longer hands a token to JavaScript. Setting it to `"true"` restores the old
behaviour and gives up most of what the change bought.
