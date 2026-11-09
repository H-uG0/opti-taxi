/**
 * Cross-site request check for the JSON route handlers that change data
 * (server actions get the same check from Next.js itself, see
 * node_modules/next/dist/server/app-render/action-handler.js). Pure module
 * (unit-tested).
 *
 * The session cookie is SameSite=Lax, so a cross-site POST does not carry it
 * anyway; this is the second lock. A request is refused when the browser says
 * it comes from another site (Sec-Fetch-Site) or when its Origin is not the
 * host it was sent to (X-Forwarded-Host behind a reverse proxy, else Host). A
 * request without Origin (a script, an old browser) passes, as in Next.js: it
 * cannot hold the user's cookie without the user.
 */

type HeaderReader = { get(name: string): string | null };

export function isSameOriginRequest(headers: HeaderReader): boolean {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // "null" (sandboxed frame, file:) or garbage.
    return false;
  }
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
  return Boolean(host) && originHost === host;
}
