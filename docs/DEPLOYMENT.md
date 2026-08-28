# Deploying Mike (Docker, LAN-accessible)

Runs the whole stack — Postgres + backend + frontend — with Docker Compose on a
Linux server, reachable from any machine on the network at `http://<server-ip>:3000`.

## How it fits together

- **frontend** (Next.js) on port **3000** — what users open.
- **backend** (Express API) on port **3001** — the browser calls it directly.
  The frontend derives the backend URL from the page host at runtime, so opening
  `http://<server-ip>:3000` makes the browser call `http://<server-ip>:3001`.
  **Both ports must be reachable from client machines.**
- **postgres** on the internal compose network (port 5433 exposed only for
  host-side debugging).
- **LDAP** (`172.18.x`) and **surf/S3** (`172.20.x`) are external. The server —
  and thus the containers (via NAT) — must be able to route to them.

## Prerequisites (on the Linux server)

1. Docker Engine + Compose v2 (`docker compose version`).
2. Network route to the LDAP and surf/S3 hosts (test: `nc -vz 172.18.200.150 389`
   and `curl -s http://172.20.202.10:7480` from the server).
3. The repo on the server, and a filled-in `backend/.env`.

## Configure secrets

Copy the example and fill it in (LDAP, surf/S3, session secret, etc.):

```bash
cp backend/.env.example backend/.env
$EDITOR backend/.env
```

`DATABASE_URL`, `FRONTEND_URL`, and `SOFFICE_BINARY_PATH` in `.env` are
**overridden** by docker-compose for the container network, so their values
there don't matter. Everything else (LDAP_*, S3_*, SESSION_JWT_SECRET,
USER_API_KEYS_ENCRYPTION_SECRET, DOWNLOAD_SIGNING_SECRET, model keys) is used.

Generate fresh secrets for a real deployment:
```bash
openssl rand -hex 32   # SESSION_JWT_SECRET, DOWNLOAD_SIGNING_SECRET, USER_API_KEYS_ENCRYPTION_SECRET
```

## Open the firewall

Allow the two app ports on the LAN (example with ufw):
```bash
sudo ufw allow 3000/tcp
sudo ufw allow 3001/tcp   # REQUIRED — the browser calls the API directly
```

## Start

```bash
docker compose up -d --build
docker compose logs -f backend        # watch startup
```

First start initializes Postgres from `backend/db/initdb/00-auth-shim.sql` then
`backend/schema.sql` (once). Then browse to `http://<server-ip>:3000` and log in
with an LDAP account.

## Operate

```bash
docker compose ps                 # status
docker compose logs -f frontend   # or backend / postgres
docker compose up -d --build      # redeploy after a code change
docker compose down               # stop (keeps data)
docker compose down -v            # stop + wipe DB (re-runs init scripts)
```

## Going to production

The base `docker-compose.yml` is tuned for easy LAN access. For a real
deployment, apply the production overlay on top of it:

```bash
export POSTGRES_PASSWORD='<a real password>'
export APP_PUBLIC_URL='https://mike.example.com'
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The overlay pins CORS to `APP_PUBLIC_URL`, sets `NODE_ENV=production`, stops
publishing the Postgres port, takes the DB password from the environment, and
caps container log growth. Use the same two `-f` flags for every later
`docker compose` command (`logs`, `ps`, `down`) or you will act on the base
config instead.

### Startup config check

With `NODE_ENV=production` the backend validates its environment before binding
a port and **exits** if something fatal is wrong (`backend/src/lib/config.ts`):
a missing or placeholder secret, two secrets sharing a value, no `DATABASE_URL`,
no LDAP config, no S3 config, or no `CUSTOM_LLM_BASE_URL`. Non-fatal issues
(no SMTP, wildcard CORS, missing `APP_PUBLIC_URL`) are logged as warnings. If the
backend container restart-loops, read its logs first — the `[config] ERROR`
lines say exactly what is missing.

Outside production the same problems are printed as warnings and startup
continues, so a partial local setup still runs.

### Pre-flight checklist

- [ ] **Fresh secrets.** Generate new values for `SESSION_JWT_SECRET`,
      `DOWNLOAD_SIGNING_SECRET`, and `USER_API_KEYS_ENCRYPTION_SECRET`
      (`openssl rand -hex 32` each, all different). Rotating the session secret
      logs everyone out; rotating the encryption secret makes stored per-user API
      keys and enrolled authenticators unreadable — so set them **before** users
      onboard, not after.
- [ ] **Real database password.** `mike_local_dev` from the base file is a
      development default.
- [ ] **`APP_PUBLIC_URL` set.** Without it, invitation emails link to
      `http://localhost:3000`.
- [ ] **TLS in front.** See HTTPS below — this is the one item the compose files
      cannot do for you.
- [ ] **Remove dead env.** `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and
      `RESEND_API_KEY` are no longer read by any code; delete them from `.env`.
- [ ] **Model endpoint reachable from the container.** Confirm with
      `docker compose exec backend node -e "fetch(process.env.CUSTOM_LLM_BASE_URL+'/models').then(r=>console.log(r.status))"`.
- [ ] **SMTP verified.** Sign in, then `GET /health/smtp` (auth required) — it
      runs a real handshake without sending mail.
- [ ] **Database backups.** Nothing here schedules them:
      `docker compose exec postgres pg_dump -U mike mike | gzip > mike-$(date +%F).sql.gz`,
      on a cron, off-box. The `mike_pgdata` volume is the only copy of user data.
- [ ] **Migrations applied.** A fresh volume loads `schema.sql` automatically; an
      existing database needs the dated files in `backend/migrations/` run in
      filename order.

## Notes & hardening

- **CORS** is set to `FRONTEND_URL: "*"` (reflect any origin) in the base file for
  easy LAN access; auth is Bearer-token (not cookies), so this is acceptable
  internally. The production overlay pins it to `APP_PUBLIC_URL`.
- **HTTPS**: the compose stack serves plain HTTP. LDAP passwords and session JWTs
  travel in the clear — fine on a trusted LAN, **not** for the public internet.
  Put a reverse proxy (Caddy/nginx) with TLS in front, point `APP_PUBLIC_URL` at
  it, and set `TRUST_PROXY_HOPS` to the number of proxies so rate limiting sees
  real client IPs. Note the browser calls the API directly, so the proxy must
  terminate TLS for **both** the app and the API (either two hostnames, or one
  hostname with `/api` routed to `backend:3001` plus
  `NEXT_PUBLIC_API_BASE_URL` set to match).
- **Custom LLM**: if you use a self-hosted OpenAI-compatible endpoint on the
  *host* (e.g. Ollama on `localhost:11434`), the backend container can't reach
  the host via `localhost`. Set `CUSTOM_LLM_BASE_URL` to the host's LAN IP (or
  `http://host.docker.internal:11434/v1` with an `extra_hosts` mapping).
- **Postgres port 5433** is exposed for debugging by the base file; the
  production overlay removes that mapping.
- To pin the backend URL instead of runtime derivation, set
  `NEXT_PUBLIC_API_BASE_URL` on the `frontend` service and rebuild.
