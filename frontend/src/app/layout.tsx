import type { Metadata } from "next";
import Script from "next/script";
import { Inter, EB_Garamond } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({
    variable: "--font-inter",
    subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
    variable: "--font-eb-garamond",
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
    metadataBase: new URL("https://app.mikeoss.com"),
    title: "Mike - AI Legal Platform",
    description:
        "AI-powered legal document analysis and contract review platform.",
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: "https://app.mikeoss.com",
        siteName: "Mike",
        title: "Mike - AI Legal Platform",
        description:
            "AI-powered legal document analysis and contract review platform.",
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: "Mike",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "Mike - AI Legal Platform",
        description:
            "AI-powered legal document analysis and contract review platform.",
        images: ["/link-image.jpg"],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className={`${inter.variable} ${ebGaramond.variable} font-sans antialiased`}
            >
                {/*
                  Runtime backend URL (see app/env.js/route.ts). beforeInteractive
                  is required, not cosmetic: lib/mikeApi.ts resolves the base URL
                  once at module scope, so this has to run before the application
                  bundle does. It is a no-op when API_BASE_URL is unset, which is
                  the docker-compose case.
                */}
                <Script src="/env.js" strategy="beforeInteractive" />
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
