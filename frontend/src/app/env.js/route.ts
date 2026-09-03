// Runtime configuration for the browser bundle.
//
// Next inlines NEXT_PUBLIC_* into the client bundle when `next build` runs, so
// anything configured that way is fixed at image-build time. UAT and production
// need different backend URLs and must be the SAME image — otherwise "we tested
// it in UAT" stops meaning anything. This route reads the container's
// environment on each request instead and hands the value to the page.
//
// Served as an external script rather than inlined into the document so that
// (a) it cannot be affected by however the layout is rendered or prerendered,
// and (b) the value never has to be escaped for a </script> sequence.
//
// Loaded from app/layout.tsx with strategy="beforeInteractive", which puts it
// ahead of the application bundle — lib/mikeApi.ts resolves the base URL once,
// at module scope, so it has to be there before that module evaluates.

// Never prerendered or cached: the whole point is to read the environment of
// the container answering this request.
export const dynamic = "force-dynamic";

export function GET(): Response {
    const base = (process.env.API_BASE_URL ?? "").trim();
    return new Response(
        `window.__MIKE_API_BASE__=${JSON.stringify(base)};\n`,
        {
            headers: {
                "Content-Type": "application/javascript; charset=utf-8",
                // A cached copy would survive a redeploy pointing somewhere else.
                "Cache-Control": "no-store, no-cache, must-revalidate",
            },
        },
    );
}
