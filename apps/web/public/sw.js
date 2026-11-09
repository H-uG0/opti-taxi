/*
 * Opti-Taxi — service worker of the driver app, registered with scope
 * /chauffeur by app/chauffeur/_components/driver-app.tsx. Written by hand, no
 * dependency; tested by src/lib/service-worker.test.ts.
 *
 * What it does: when a page of the driver app cannot be loaded (no network, no
 * answer within 20 s, or the server unreachable behind the proxy), it answers
 * with a minimal page: « Pas de réseau » (or « Feuille de route indisponible »
 * when the network answers but the app does not), the regulation's number,
 * the time of the last sync, « Réessayer ». Without it, a PWA killed during a
 * long Waze navigation and reopened in a white zone shows the browser's error
 * page. The page is static (no script): the statuses waiting on the phone
 * leave once the roadmap opens again with the network.
 *
 * What it keeps (Cache API, CACHE below), and nothing else:
 * - the app icon, shown on the offline page;
 * - META_URL: the regulation's number and the time of the last sync, posted
 *   by the roadmap after each render.
 * Never a page, an API answer or any patient data: network answers pass
 * through untouched and are never stored. A copy of the roadmap for offline
 * use (encrypted) is a decision of the DPO and the HDS host, not made here.
 */
"use strict";

const CACHE = "opti-taxi-offline-v1";
const META_URL = "/__opti-taxi/offline-meta";
const SHELL = ["/icons/icon.svg"];
const NAVIGATION_TIMEOUT_MS = 20000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("opti-taxi-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Pages of the driver app (not /chauffeurs, the regulator's list, which the scope prefix also covers). */
function isDriverPage(url) {
  return url.origin === self.location.origin && (url.pathname === "/chauffeur" || url.pathname.startsWith("/chauffeur/"));
}

function isShellAsset(url) {
  return url.origin === self.location.origin && SHELL.includes(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate" && isDriverPage(url)) {
    event.respondWith(networkOrOfflinePage(request, url));
  } else if (isShellAsset(url) && request.mode !== "navigate") {
    // The icon of the offline page: from the network when it answers, else the copy kept at install.
    event.respondWith(fetch(request).catch(() => caches.match(url.pathname).then((cached) => cached || Response.error())));
  }
  // Anything else (Next.js data, API calls, other pages) goes to the network untouched.
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function networkOrOfflinePage(request, url) {
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    // A proxy that cannot reach the app answers 502 to 504: its page is of no use in a car.
    if (response.status >= 502 && response.status <= 504) return offlinePage(url, "unavailable");
    return response;
  } catch (error) {
    // No answer in time: the network may be up and the app slow or down. A failed fetch: no network.
    return offlinePage(url, error instanceof Error && error.message === "timeout" ? "unavailable" : "offline");
  }
}

/** Only a number and a time are kept: anything else in the message is dropped. */
function sanitizeMeta(data) {
  const at = typeof data.at === "number" && Number.isFinite(data.at) ? data.at : null;
  const regulator = data.regulator;
  const validRegulator =
    regulator &&
    typeof regulator.number === "string" &&
    typeof regulator.href === "string" &&
    /^tel:\+?\d{3,20}$/.test(regulator.href);
  return { at, regulator: validRegulator ? { number: regulator.number.slice(0, 40), href: regulator.href } : null };
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== "roadmap-synced") return;
  const meta = sanitizeMeta(data);
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.put(META_URL, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }))),
  );
});

async function readMeta() {
  try {
    const cached = await caches.match(META_URL);
    return cached ? sanitizeMeta(await cached.json()) : { at: null, regulator: null };
  } catch {
    return { at: null, regulator: null };
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function formatSync(at) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a;line-height:1.45}
header{background:#1d4c4a;color:#fff;padding:12px 16px;font-weight:600}
header small{display:block;color:#afe2dd;font-size:11px;letter-spacing:.18em;text-transform:uppercase}
main{max-width:32rem;margin:0 auto;padding:24px 16px calc(32px + env(safe-area-inset-bottom))}
h1{font-size:1.4rem;margin:12px 0 4px}
p{margin:8px 0}
.icon{display:block;width:56px;height:56px;border-radius:14px}
.btn{display:flex;align-items:center;justify-content:center;min-height:52px;border-radius:14px;padding:10px 16px;font-size:1.05rem;font-weight:600;text-decoration:none;margin-top:12px;text-align:center}
.call{background:#1f5e5b;color:#fff}
.retry{background:#fff;color:#0f172a;border:1px solid #cbd5e1}
.note{border:1px solid #fcd34d;background:#fffbeb;color:#451a03;border-radius:12px;padding:10px 12px}
.sync{color:#475569;font-size:.9rem;margin-top:20px}
`;

/** Words of the page: no network at all, or a network that does not reach the app (timeout, proxy 502–504). */
const CAUSES = {
  offline: {
    title: "Hors connexion",
    heading: "Pas de réseau",
    text: "La feuille de route ne s'affiche pas sans connexion&nbsp;: elle n'est jamais gardée sur le téléphone (données de santé).",
  },
  unavailable: {
    title: "Indisponible",
    heading: "Feuille de route indisponible",
    text: "Le serveur ne répond pas pour le moment. La feuille de route n'est jamais gardée sur le téléphone (données de santé).",
  },
};

async function offlinePage(url, cause) {
  const words = CAUSES[cause] || CAUSES.offline;
  const meta = await readMeta();
  const retryHref = escapeHtml(url.pathname + url.search);
  const call = meta.regulator
    ? `<a class="btn call" href="${escapeHtml(meta.regulator.href)}">Appeler la régulation · ${escapeHtml(meta.regulator.number)}</a>`
    : `<p><strong>En cas d'urgence, appelez la régulation.</strong></p>`;
  const sync = meta.at
    ? `Dernière synchronisation de la feuille de route&nbsp;: ${escapeHtml(formatSync(meta.at))}.`
    : "Aucune synchronisation enregistrée sur ce téléphone.";
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f5e5b">
<title>${words.title} — Opti-Taxi</title>
<style>${STYLE}</style>
</head>
<body>
<header><small>Feuille de route</small>Opti-Taxi</header>
<main>
<img class="icon" src="/icons/icon.svg" alt="">
<h1>${words.heading}</h1>
<p>${words.text}</p>
<p class="note">Les statuts déjà saisis restent gardés sur le téléphone, avec l'heure du geste. Ils partent quand la feuille de route se rouvre avec du réseau («&nbsp;Réessayer&nbsp;»).</p>
${call}
<a class="btn retry" href="${retryHref}">Réessayer</a>
<p class="sync">${sync}</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
