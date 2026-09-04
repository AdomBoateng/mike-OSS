import type { NextConfig } from "next";

const scriptPolicy =
    process.env.NODE_ENV === "production"
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
const contentSecurityPolicy = [
    "default-src 'self'",
    scriptPolicy,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "worker-src 'self' blob:",
].join("; ");

const nextConfig: NextConfig = {
    poweredByHeader: false,
    // Self-contained server bundle for Docker (.next/standalone/server.js).
    output: "standalone",
    reactCompiler: true,
    async rewrites() {
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
        ];
    },
    skipTrailingSlashRedirect: true,
    async headers() {
        return [
            {
                source: "/:path*",
                headers: [
                    { key: "X-Content-Type-Options", value: "nosniff" },
                    { key: "Referrer-Policy", value: "no-referrer" },
                    { key: "X-Frame-Options", value: "DENY" },
                    {
                        key: "Strict-Transport-Security",
                        value: "max-age=15552000; includeSubDomains",
                    },
                    {
                        key: "Permissions-Policy",
                        value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
                    },
                    {
                        key: "Content-Security-Policy",
                        value: contentSecurityPolicy,
                    },
                ],
            },
        ];
    },
};

export default nextConfig;
