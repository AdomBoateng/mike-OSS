// Single source of truth for the backend base URL.
//
// Resolved in this order, first hit wins:
//
//   1. window.__MIKE_API_BASE__ — injected at RUNTIME by /env.js (see
//      app/env.js/route.ts), from API_BASE_URL in the frontend container's
//      environment. This is what a Kubernetes deployment uses: NEXT_PUBLIC_*
//      values are inlined into the bundle when `next build` runs, so baking one
//      would mean a separate image per environment, and UAT and production
//      would stop being the same artifact.
//
//      The value may be a relative path — "/api" is the normal one, for an
//      ingress that serves both apps from a single hostname. Same-origin means
//      no CORS and no second port to open.
//
//   2. NEXT_PUBLIC_API_BASE_URL — baked at build. Still honoured for anyone
//      building their own image with a fixed backend URL.
//
//   3. Derived from the page host: http://<host>:3001. This is the
//      docker-compose shape, where the two apps are on separate ports of the
//      same machine and the browser talks to both. Requires port 3001 to be
//      reachable from the client.
//
//   4. On the server (SSR) fall back to localhost; the API is only ever called
//      from the browser.

declare global {
    interface Window {
        __MIKE_API_BASE__?: string;
    }
}

export function getApiBase(): string {
    if (typeof window !== "undefined") {
        const injected = window.__MIKE_API_BASE__;
        if (injected && injected.trim()) return injected.trim().replace(/\/+$/, "");
    }
    const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (configured && configured.trim()) return configured.trim();
    if (typeof window !== "undefined") {
        const port = process.env.NEXT_PUBLIC_API_PORT || "3001";
        return `${window.location.protocol}//${window.location.hostname}:${port}`;
    }
    return "http://localhost:3001";
}
