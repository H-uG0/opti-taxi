/**
 * Session cookie name and attributes. Pure module so the rule is unit-tested.
 *
 * In production the name carries the `__Host-` prefix: the browser then keeps
 * the cookie only if it is Secure, has Path=/ and no Domain, so neither a
 * sibling subdomain nor a plain-HTTP response can plant or overwrite a session
 * cookie (session fixation). Development keeps "ot_session" without Secure:
 * `next dev` serves plain http://localhost. Chromium and Firefox treat
 * http://localhost (and 127.0.0.1) as a secure origin for cookies, so
 * `next start` there still signs in (Safari does not: test production behind
 * HTTPS).
 *
 * Production mode needs HTTPS on any other origin. Over plain http to a LAN
 * address (a phone testing the driver PWA at http://192.168.x.x:3100 under
 * `next start`) the browser drops the Secure cookie, so every sign-in lands
 * back on /login, and the CSP's upgrade-insecure-requests (production only)
 * rewrites the page's own scripts and styles to https, which then fail to
 * load. Test from a phone with `next dev`, or behind an HTTPS tunnel or
 * reverse proxy.
 */

export type SessionCookie = {
  name: string;
  attributes: { httpOnly: true; sameSite: "lax"; secure: boolean; path: "/" };
};

export function sessionCookie(nodeEnv: string | undefined): SessionCookie {
  const production = nodeEnv === "production";
  return {
    name: production ? "__Host-ot_session" : "ot_session",
    attributes: { httpOnly: true, sameSite: "lax", secure: production, path: "/" },
  };
}
