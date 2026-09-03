import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    /* config options here */
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
};

export default nextConfig;
