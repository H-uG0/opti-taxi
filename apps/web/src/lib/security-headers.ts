/**
 * HTTP security headers. Pure module (no Next.js import): next.config.ts sends
 * the fixed headers on every response, src/proxy.ts sends the Content Security
 * Policy with a fresh nonce on every page request, and both are unit-tested.
 */

export type HeaderEntry = { key: string; value: string };

/**
 * Headers that do not change per request (next.config.ts `headers()`, all
 * paths, static files included).
 * - HSTS only in production: over plain http://localhost browsers ignore it
 *   anyway, and a localhost pinned to HTTPS for two years would break every
 *   other dev server on the machine.
 * - Permissions-Policy: the app uses none of these features. The driver
 *   roadmap opens Google Maps / Waze links and never reads the position
 *   (no navigator.geolocation; the planning map has no GeolocateControl).
 * - X-Frame-Options stays for browsers without CSP `frame-ancestors`.
 */
export function securityHeaders(nodeEnv: string | undefined): HeaderEntry[] {
  return [
    ...(nodeEnv === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Origin only to other sites (never a path with ids): the OpenStreetMap
    // raster fallback refuses tile requests that carry no Referer at all.
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
}

/**
 * Hosts the map styles of the app load from (style JSON, TileJSON, vector and
 * raster tiles, glyphs, sprites). Keep it in step with
 * src/components/map/map-style.ts and NEXT_PUBLIC_MAP_STYLE_URL:
 * - tiles.openfreemap.org: the default style (.env.example,
 *   https://tiles.openfreemap.org/styles/liberty) and everything it
 *   references: TileJSON /planet and its /planet/<version>/{z}/{x}/{y}.pbf
 *   tiles, /natural_earth raster tiles, /fonts glyphs, /sprites;
 * - tile.openstreetmap.org: OSM_RASTER_STYLE, the fallback used when the
 *   vector style is not configured or fails to load.
 * A custom style URL adds its own origin (mapOrigins); a style whose sources,
 * glyphs or sprites live on yet another host needs that host added here.
 */
export const MAP_HOSTS = ["https://tiles.openfreemap.org", "https://tile.openstreetmap.org"] as const;

/** MAP_HOSTS plus the origin of the configured style URL (http or https only). */
export function mapOrigins(styleUrl: string | null | undefined): string[] {
  const origins = new Set<string>(MAP_HOSTS);
  const trimmed = styleUrl?.trim();
  if (trimmed) {
    try {
      const url = new URL(trimmed);
      if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
    } catch {
      // Not a URL: the map falls back to OSM_RASTER_STYLE, already allowed.
    }
  }
  return [...origins];
}

export type CspOptions = {
  /** Fresh per request: base64, at least 128 random bits. */
  nonce: string;
  nodeEnv: string | undefined;
  /** NEXT_PUBLIC_MAP_STYLE_URL. */
  mapStyleUrl?: string | null;
};

/**
 * Content-Security-Policy of a page, following the nonce setup of
 * node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md:
 * Next.js reads the nonce from this header on the request and puts it on its
 * own scripts; 'strict-dynamic' lets those load the chunks they import.
 * - 'unsafe-eval' only in development (React rebuilds server error stacks
 *   with eval); upgrade-insecure-requests only in production.
 * - style-src 'unsafe-inline' and no nonce there (a nonce would disable
 *   'unsafe-inline'): React style props, Tailwind and MapLibre set inline
 *   styles.
 * - worker-src 'self': the driver app's service worker (public/sw.js,
 *   registered from /chauffeur, see serviceWorkerHeaders). MapLibre GL
 *   (maplibre-gl/build/rollup/bundle_prelude.js) starts its web workers from a
 *   blob: URL, hence worker-src blob: and child-src blob: (older Safari); it
 *   decodes images through data: and blob: URLs (img-src) and fetches styles,
 *   tiles, glyphs and sprites (connect-src; img-src for browsers that load
 *   raster tiles as images).
 * - form-action 'self': server actions post to the page itself; their
 *   redirects stay on this origin.
 */
export function contentSecurityPolicy({ nonce, nodeEnv, mapStyleUrl }: CspOptions): string {
  const dev = nodeEnv === "development";
  const map = mapOrigins(mapStyleUrl);
  const directives: [name: string, sources: string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", ...map]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...map]],
    ["worker-src", ["'self'", "blob:"]],
    ["child-src", ["blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  if (nodeEnv === "production") directives.push(["upgrade-insecure-requests", []]);
  return directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

/**
 * Headers of the service worker script (/sw.js, next.config.ts; the proxy
 * skips it). Never cached by the browser, so a new version is picked up at the
 * next visit; its own policy only lets it reach this origin (it fetches pages
 * of the driver app and nothing else).
 */
export function serviceWorkerHeaders(): HeaderEntry[] {
  return [
    { key: "Content-Type", value: "application/javascript; charset=utf-8" },
    { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
    { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'" },
  ];
}

/** A CSP nonce: 128 random bits in base64 (Web Crypto, available in the proxy runtime). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
