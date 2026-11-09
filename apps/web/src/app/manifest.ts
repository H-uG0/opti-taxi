import type { MetadataRoute } from "next";

/**
 * Web app manifest: drivers add the roadmap (/chauffeur) to their phone's home
 * screen and open it full screen like an app.
 *
 * Deliberately no offline caching of pages: the roadmap shows patient health
 * data (names, addresses, phone numbers, access notes, care facilities). A
 * cached copy would survive logout on a lost or stolen phone and live outside
 * the HDS-certified hosting. Pages are always rendered by the server for the
 * signed-in driver (dynamic, not stored by the browser). The service worker
 * (public/sw.js) keeps only the app icon, the regulation's number and the time
 * of the last sync, for a minimal offline page when the app is reopened with
 * no network; statuses tapped offline wait in the phone's queue (ids and
 * times only). An encrypted offline copy of the roadmap is a decision for the
 * DPO and the HDS host.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/chauffeur",
    name: "Opti-Taxi — Chauffeur",
    short_name: "Opti-Taxi",
    description: "Feuille de route du chauffeur : arrêts du jour, itinéraires et statuts des transports.",
    start_url: "/chauffeur",
    scope: "/",
    display: "standalone",
    theme_color: "#1f5e5b",
    background_color: "#f8fafc",
    lang: "fr",
    dir: "ltr",
    categories: ["medical", "navigation", "business"],
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
