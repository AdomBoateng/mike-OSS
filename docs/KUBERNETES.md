# Deploying Mike on Kubernetes (UAT and production)

The Docker Compose setup in [DEPLOYMENT.md](DEPLOYMENT.md) is still the way to run
Mike on a single Linux box. This page is for the GitLab → Kubernetes path: two
namespaces, images built by CI, and a Postgres, object store and directory that
live outside the cluster.

Read [What will bite you](#what-will-bite-you) before the first deploy. Most of
it is not guessable from the manifests.

## Shape

```
                    ┌──────────────────────────────────────┐
   browser ──TLS──▶ │ Ingress   mike.<host>                │
                    │   /api/*  ──▶ Service mike-backend   │
                    │   /*      ──▶ Service mike-frontend  │
                    └──────────────────────────────────────┘
                                    │
              ┌─────────────────────┴──────────────────────┐
              ▼                                            ▼
      Deployment mike-backend  :3001            Deployment mike-frontend :3000
              │
              ├──▶ Postgres          (outside the cluster, yours)
              ├──▶ surf / S3         (outside the cluster, yours)
              ├──▶ LDAP / FreeIPA    (outside the cluster, yours)
              ├──▶ vLLM endpoint     (outside the cluster, yours)
              ├──▶ SMTP              (outside the cluster, yours)
              └──▶ SearXNG           (in-cluster, optional — k8s/searxng/)
```

**One hostname, split by path.** `/api` goes to the backend, everything else to
the frontend. That is a deliberate change from the Compose setup, where the
browser talks to port 3001 directly and the frontend derives the API host from
the page URL. Under an ingress that would mean a second hostname, a second
certificate, a second firewall rule and real CORS. Same-origin path routing
costs one config value and removes all of it.

Two pieces make it work, and they have to agree:

| Where | Variable | Value |
| --- | --- | --- |
| backend | `API_BASE_PATH` | `/api` — the app strips this prefix itself (`src/lib/basePath.ts`), so no `rewrite-target` annotation and nothing controller-specific |
| frontend | `API_BASE_URL` | `/api` — read at **request** time by `app/env.js/route.ts` and handed to the browser |

`API_BASE_URL` is not `NEXT_PUBLIC_API_BASE_URL` on purpose. Next inlines
`NEXT_PUBLIC_*` into the client bundle when `next build` runs, so using it would
bake one environment's URL into the image and UAT and production could no longer
be the same artifact — which would make "we tested it in UAT" mean nothing.

## What you need before the first deploy

Per environment, from outside the cluster:

1. **A Postgres database and a role that owns it.** Empty is fine and expected —
   the migration Job creates everything. On a fresh database that role needs to
   be able to create a schema (`auth`), install the `pgcrypto` extension, and
   create roles: `schema.sql` is loaded unmodified and still ends with
   `revoke … from anon, authenticated`, so those Supabase-era roles have to
   exist as inert `NOLOGIN` roles for it to load at all. On an existing database
   ordinary ownership is enough.
2. **A bucket on surf/S3**, and a key pair with read/write on it. Use a
   different bucket for UAT than for production.
3. **A route from the cluster's pod network to LDAP, S3, Postgres, the vLLM
   endpoint and SMTP.** All five are outside the cluster. The backend proves it
   can reach S3 and LDAP *before* it binds a port, so a missing route shows up
   as a pod that never becomes ready, with the reason in its logs — not as a
   mystery failure on someone's first upload.
4. **DNS and a TLS certificate** for the hostname in the overlay.
5. **Three fresh secrets per environment** (`openssl rand -hex 32` each).
   UAT and production must not share them — see
   [k8s/secret.example.yaml](../k8s/secret.example.yaml) for why each one
   matters and what rotating it breaks.

## One-time setup, per environment

```bash
kubectl apply -k k8s/overlays/uat   # creates the namespace and everything else
```

Then the Secret, which CI deliberately does not manage — keeping the directory
bind password out of the pipeline means a compromised runner cannot read it from
a job log:

```bash
kubectl -n mike-uat create secret generic mike-secrets --from-env-file=backend/.env.uat
```

`backend/.env.example` documents every variable; `k8s/secret.example.yaml` lists
which of them are secret and therefore belong here rather than in
`k8s/base/configmap.yaml`. If the cluster has SealedSecrets or External Secrets,
use it — an encrypted SealedSecret can live in this repo, a plain Secret cannot.

Open-web search is optional. To run SearXNG in-cluster (the recommendation —
it is one application's internal dependency, holds nothing worth keeping, and in
here it gets a ClusterIP and no Ingress):

```bash
kubectl -n mike-uat create secret generic searxng-secret --from-literal=SEARXNG_SECRET="$(openssl rand -hex 32)"
kubectl -n mike-uat apply -f k8s/searxng/searxng.yaml
```

and set `SEARXNG_BASE_URL=http://searxng:8080` in `mike-secrets`. Do not put an
Ingress in front of it: an open SearXNG is an open proxy, and anyone who reaches
it can make this network issue arbitrary outbound requests.

## The database

There is no equivalent of the Compose setup's Postgres entrypoint hook, which is
what seeds a new volume there. A Job does it instead, running the backend image
with a different command, so the SQL applied is always the SQL that shipped with
the code being deployed.

```bash
node dist/scripts/migrate.js            # what the Job runs
node dist/scripts/migrate.js --dry-run  # say what it would do and stop
```

It decides for itself which of two things the database needs:

- **Fresh** (no `public.user_profiles`): apply `db/initdb/00-auth-shim.sql`, then
  `schema.sql`, then record all migration filenames as applied. `schema.sql` is
  the complete current shape, so replaying the historical migrations over it
  would be pointless; baselining is what stops the next run trying.
- **Existing**: apply the dated files in `backend/migrations/` this database has
  not recorded yet, oldest first, each in its own transaction.

Both paths are idempotent and it takes a Postgres advisory lock, so the same Job
is what a brand-new UAT namespace runs and what a routine production deploy
runs, and a retried pipeline racing itself is safe. State lives in
`public.schema_migrations`.

**Adopting an existing Compose database.** A database that already has Mike's
tables but no `schema_migrations` — one deployed before this script existed — is
the one case the script refuses to guess at. It stops with a non-zero exit and
says so, rather than replaying 44 files of unknown relevance: several of the
older ones move data rather than just adding columns, and replaying those over
live rows does real damage.

Two ways forward, and you have to pick one:

```bash
# It is already current with this build — the usual case. Record the
# migrations as applied without running any of them.
node dist/scripts/migrate.js --baseline
```

If it is genuinely behind, create the ledger by hand and insert only the
filenames it *has* had applied, then run the script normally:

```sql
create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (filename) values ('20260419_tabular_chat_jsonb.sql'), ...;
```

`--dry-run` prints what either path would do and changes nothing.

## Deploying

CI does it (`.gitlab-ci.yml`): UAT on every push to the default branch,
production manually, on a tag. The order matters and is not negotiable —
migrate to completion first, then roll:

```bash
kubectl -n mike-uat delete job mike-migrate --ignore-not-found --wait=true
kubectl apply -k k8s/overlays/uat/migrate
kubectl -n mike-uat wait --for=condition=complete job/mike-migrate --timeout=600s
kubectl apply -k k8s/overlays/uat
kubectl -n mike-uat rollout status deployment/mike-backend --timeout=900s
```

The Job is deleted first because a completed Job's pod template is immutable.

**Rollback** is a re-deploy of the previous image tag; images are tagged with the
commit SHA precisely so there is something to name:

```bash
kubectl -n mike-prod set image deployment/mike-backend backend=<registry>/backend:<sha>
kubectl -n mike-prod set image deployment/mike-frontend frontend=<registry>/frontend:<sha>
```

Note this rolls back **code, not schema**. Nothing here reverses a migration, and
that is intentional: an automatic down-migration in production destroys data
faster than it fixes anything. A migration that has to be undone gets a new
forward migration that undoes it.

## What will bite you

### Streaming through the ingress

The assistant answers over Server-Sent Events, and a single answer can run past
ten minutes — a full contract redraft measured 10m40s in testing. nginx's
defaults kill that request at 60 seconds, and the user sees an answer that stops
mid-sentence: exactly the symptom of the undici body-timeout bug this project
already fixed once, arriving from a completely different layer. `proxy-buffering`
is just as important — with it on, nginx holds the entire answer and delivers it
in one lump at the end, so the user stares at a spinner instead of watching text
arrive.

The three annotations are in [`k8s/base/ingress.yaml`](../k8s/base/ingress.yaml).
If you use a controller other than nginx, they have equivalents and you must set
them. This is the single most likely way a deploy that "works" is unusable.

### Uploads

The app caps uploads at 100MB. nginx's default is 1MB, which rejects any real
document with a 413 before the app sees it. `proxy-body-size: 110m` is set on the
ingress; leave room over 100MB for multipart overhead.

### The startup probes are supposed to be slow

Before binding a port the backend does a `HeadBucket` against S3 and an LDAP bind
as the search account, retrying network faults 3×/2s each, and in production a
failure exits the process. That is deliberate — an unroutable directory means
nobody can sign in, and finding out at boot beats finding out from a user. It
means a `startupProbe` with room (30 × 5s) rather than a kubelet restart partway
through the app's own retries.

If a pod is CrashLooping, read its logs before touching the probes. It is telling
you which dependency it cannot reach, and it distinguishes *unreachable* (no
answer — routing or firewall) from *denied* (bad credentials), because those have
entirely different fixes.

### Rolling updates cut answers off — unless you let them finish

`terminationGracePeriodSeconds: 900` on the backend is not padding. The process
handles SIGTERM by refusing new connections and letting in-flight requests
finish; with a short grace period Kubernetes kills it first and everyone
mid-answer loses it. During a rollout "a request is in flight" is the normal
case here, not a rare one.

### Docker bridge subnets can shadow LDAP and storage

Docker's default address pool (`172.17`–`172.31`) overlaps both the LDAP
(`172.18.x`) and storage (`172.20.x`) subnets. On a node running Docker
alongside the kubelet, an unrelated container network can silently blackhole
either one for everything on that host. The fix is `default-address-pools` in the
daemon config — see [DEPLOYMENT.md](DEPLOYMENT.md#docker-subnet-collisions-read-this-before-blaming-the-firewall).
Worth checking on the nodes before blaming the CNI.

### Do not share secrets between UAT and production

A shared `SESSION_JWT_SECRET` means a session token minted by UAT is accepted by
production. The other two are less dramatic but still environment-scoped; see
[k8s/secret.example.yaml](../k8s/secret.example.yaml).

## UAT vs production

| | UAT | Production |
| --- | --- | --- |
| Namespace | `mike-uat` | `mike-prod` |
| Replicas | 1 each — a rollout is a brief outage | 2 each, `maxUnavailable: 0` |
| PodDisruptionBudget | none | `minAvailable: 1` on both |
| Deploy trigger | push to the default branch | manual, on a tag |
| Bucket | separate | separate |
| Secrets | separate | separate |

## After a deploy, check

```bash
kubectl -n mike-uat get pods
kubectl -n mike-uat logs deployment/mike-backend --tail=50   # startup probe results
curl -sS https://mike-uat.<host>/api/health                  # {"ok":true}
curl -sS https://mike-uat.<host>/api/health/ready            # {"ok":true} = database reachable
curl -sS https://mike-uat.<host>/env.js                      # window.__MIKE_API_BASE__="/api"
```

Then, in a browser: sign in (proves LDAP), upload a document (proves S3), and ask
the assistant something long enough to stream for a few minutes (proves the
ingress timeouts and buffering). The last one is the check people skip and the
one that fails.

`GET /api/health/smtp` requires a session and runs a real `transporter.verify()`
without sending mail — worth hitting once per environment.

## Not in the cluster

Postgres, object storage, LDAP and the vLLM endpoint are all yours and all
external. Nothing here provisions them, and the backend is the only thing that
talks to any of them — the browser never does.
