// Single source of truth for the backend base URL, resolved at RUNTIME so one
// build works for any host.
// - If NEXT_PUBLIC_API_BASE_URL is set (baked at build), use it verbatim.
// - Otherwise, in the browser, derive it from the host the page was loaded from
//   (http://<server-ip>:<port>, default port 3001) — so opening the app at
//   http://<server-ip>:3000 targets the backend on the same host, not the
//   visitor's localhost.
// - On the server (SSR) fall back to localhost; the API is only called client-side.
export function getApiBase(): string {
    const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (configured && configured.trim()) return configured.trim();
    if (typeof window !== "undefined") {
        const port = process.env.NEXT_PUBLIC_API_PORT || "3001";
        return `${window.location.protocol}//${window.location.hostname}:${port}`;
    }
    return "http://localhost:3001";
}
