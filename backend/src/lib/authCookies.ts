import crypto from "node:crypto";
import type { Request, Response } from "express";

const DEVELOPMENT_SESSION_COOKIE = "mike_session";
const PRODUCTION_SESSION_COOKIE = "__Host-mike_session";
export const CSRF_COOKIE = "mike_csrf";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type SessionTokenSource = "cookie" | "bearer";

function cookiesAreSecure(): boolean {
  return process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false";
}

export function sessionCookieName(): string {
  return cookiesAreSecure()
    ? PRODUCTION_SESSION_COOKIE
    : DEVELOPMENT_SESSION_COOKIE;
}

export function csrfCookieName(): string {
  return CSRF_COOKIE;
}

export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function sessionTokenFromRequest(req: Request): {
  token: string | null;
  source: SessionTokenSource | null;
} {
  // Prefer the protected cookie when both are present. This makes rolling
  // Kubernetes upgrades safe when an older frontend still sends a stale
  // Authorization header alongside the new cookie.
  const cookieToken = readCookie(req.headers.cookie, sessionCookieName());
  if (cookieToken) return { token: cookieToken, source: "cookie" };
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    return { token: token || null, source: token ? "bearer" : null };
  }
  return { token: null, source: null };
}

function cookieSecurity() {
  return {
    secure: cookiesAreSecure(),
    sameSite: "lax" as const,
    path: "/",
  };
}

export function setAuthCookies(res: Response, token: string): string {
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  res.cookie(sessionCookieName(), token, {
    ...cookieSecurity(),
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_MS,
  });
  res.cookie(csrfCookieName(), csrfToken, {
    ...cookieSecurity(),
    httpOnly: false,
    maxAge: SESSION_MAX_AGE_MS,
  });
  return csrfToken;
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(sessionCookieName(), {
    ...cookieSecurity(),
    httpOnly: true,
  });
  res.clearCookie(csrfCookieName(), {
    ...cookieSecurity(),
    httpOnly: false,
  });
}

export function csrfTokenMatches(req: Request): boolean {
  const cookieToken = readCookie(req.headers.cookie, csrfCookieName());
  const header = req.headers["x-csrf-token"];
  const headerToken = Array.isArray(header) ? header[0] : header;
  if (!cookieToken || !headerToken) return false;
  const left = Buffer.from(cookieToken);
  const right = Buffer.from(headerToken);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function exposeLegacyBearerTokens(): boolean {
  return process.env.ALLOW_BEARER_TOKEN_RESPONSE === "true";
}
