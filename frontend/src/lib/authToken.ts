// Browser authentication now uses an HttpOnly cookie. This module retains only
// the narrow compatibility bridge needed to exchange sessions created by older
// releases, then removes the legacy token from localStorage.

const TOKEN_KEY = "mike:session-token";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  for (const item of document.cookie.split(";")) {
    const trimmed = item.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(trimmed.slice(prefix.length));
    } catch {
      return null;
    }
  }
  return null;
}

export function getAuthRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const legacyToken = getStoredToken();
  const csrfToken = readCookie("mike_csrf");
  if (legacyToken) headers.Authorization = `Bearer ${legacyToken}`;
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return headers;
}
