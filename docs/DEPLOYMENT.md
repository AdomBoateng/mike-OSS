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

## Notes & hardening

- **CORS** is set to `FRONTEND_URL: "*"` (reflect any origin) for easy LAN access;
  auth is Bearer-token (not cookies), so this is acceptable internally. For an
  internet-facing deployment, set it to the exact origin(s), comma-separated.
- **HTTPS**: this serves plain HTTP. LDAP passwords and session JWTs travel in
  the clear — fine on a trusted LAN, **not** for the public internet. For that,
  put a reverse proxy (Caddy/nginx) with TLS in front and lock CORS down.
- **Custom LLM**: if you use a self-hosted OpenAI-compatible endpoint on the
  *host* (e.g. Ollama on `localhost:11434`), the backend container can't reach
  the host via `localhost`. Set `CUSTOM_LLM_BASE_URL` to the host's LAN IP (or
  `http://host.docker.internal:11434/v1` with an `extra_hosts` mapping).
- **Postgres port 5433** is exposed for debugging; remove that mapping from
  `docker-compose.yml` for a locked-down deployment.
- To pin the backend URL instead of runtime derivation, set
  `NEXT_PUBLIC_API_BASE_URL` on the `frontend` service and rebuild.
