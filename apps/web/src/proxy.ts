import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, createNonce } from "@/lib/security-headers";

/**
 * Content Security Policy with a per-request nonce (Next.js 16 `proxy`, the
 * former middleware), as in node_modules/next/dist/docs/01-app/02-guides/
 * content-security-policy.md. The policy goes on the request, where Next.js
 * reads the nonce and adds it to its scripts while rendering, and on the
 * response, where the browser enforces it. Every page of the app is rendered
 * per request (it reads the session cookie), which the nonce requires.
 *
 * Authentication stays in each page and server action (requireUser): this
 * proxy only adds headers. The fixed security headers (HSTS…) come from
 * next.config.ts and also cover the paths skipped below.
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = contentSecurityPolicy({
    nonce,
    nodeEnv: process.env.NODE_ENV,
    mapStyleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
  });

  // A policy sent by the client is replaced, so it cannot choose the nonce.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  // For a server component that needs the nonce itself (e.g. <Script nonce>): headers().get("x-nonce").
  requestHeaders.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Every path except those that are never an HTML page: build assets
     * (_next/static), optimized images (_next/image), public icons, the app
     * icon, the web app manifest, the service worker (its own headers in
     * next.config.ts). Router prefetches are skipped too (they carry no
     * document). Server actions are POSTs to the page path: covered.
     */
    {
      source:
        "/((?!_next/static|_next/image|icons/|icon\\.svg|apple-touch-icon\\.png|favicon\\.ico|manifest\\.webmanifest|sw\\.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
