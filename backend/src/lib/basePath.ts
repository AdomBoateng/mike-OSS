// Serving the API under a path prefix.
//
// A Kubernetes ingress that puts the whole app on one hostname routes `/api/*`
// to this service and everything else to the frontend. That shape is worth
// having: one DNS name, one certificate, one firewall rule, and no CORS at all,
// because the browser is then talking to its own origin. The cost is that the
// browser sends `/api/auth/login` for a route registered here as `/auth/login`.
//
// Ingress controllers can strip the prefix themselves, but each spells it
// differently — nginx wants a rewrite-target with a capture group, Traefik a
// StripPrefix middleware — and getting it wrong produces a silent 404 rather
// than an error anyone can act on. Stripping it here instead keeps the
// manifests controller-agnostic and puts the behaviour under test.

/**
 * Normalise API_BASE_PATH into either "" (not mounted under a prefix) or a
 * leading-slash, no-trailing-slash path. Accepts "api", "/api" and "/api/"
 * alike, because all three are what someone actually types.
 */
export function normalizeBasePath(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/**
 * Strip `basePath` from a request URL, or return null when it does not apply.
 *
 * Null rather than the URL unchanged is deliberate: a request that arrives
 * without the prefix is left completely alone, so `/health` still answers a
 * kubelet probe, which talks to the pod directly and never passes through the
 * ingress that would have added the prefix.
 */
export function stripBasePath(url: string, basePath: string): string | null {
  if (!basePath) return null;
  if (url === basePath) return "/";
  if (url.startsWith(`${basePath}/`)) return url.slice(basePath.length);
  // "/api?foo=1" — a query string directly on the prefix, no trailing slash.
  if (url.startsWith(`${basePath}?`)) return `/${url.slice(basePath.length)}`;
  return null;
}
