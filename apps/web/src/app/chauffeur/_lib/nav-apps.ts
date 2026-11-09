/**
 * Which navigation apps the roadmap offers, in which order: Google Maps, Waze
 * and the phone's own navigation (Apple Plans on an iPhone or iPad, where the
 * geo: link does nothing; any app through geo: elsewhere). The app the driver
 * used last is remembered on the phone and offered first. Pure module
 * (unit-tested); the reading of the phone is in nav-links.tsx.
 */
import type { NavigationLinks } from "./links";

export type NavApp = "google" | "waze" | "apple" | "geo";

export const NAV_APP_LABELS: Record<NavApp, string> = {
  google: "Google Maps",
  waze: "Waze",
  apple: "Plans",
  geo: "Autre GPS",
};

/** localStorage key of the preferred app (a word, no personal data). */
export const NAV_APP_STORAGE_KEY = "opti-taxi:navigation";

export function isNavApp(value: unknown): value is NavApp {
  return value === "google" || value === "waze" || value === "apple" || value === "geo";
}

/**
 * iPhone, iPod or iPad (iPadOS reports itself as a Mac with a touch screen).
 * `platform` and `maxTouchPoints` come from navigator.
 */
export function isApplePhone(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return platform === "MacIntel" && maxTouchPoints > 1;
}

/** The three apps offered, the preferred one first (when it is offered on this phone). */
export function navAppsFor(apple: boolean, preferred: NavApp | null): NavApp[] {
  const apps: NavApp[] = ["google", "waze", apple ? "apple" : "geo"];
  if (!preferred || !apps.includes(preferred)) return apps;
  return [preferred, ...apps.filter((app) => app !== preferred)];
}

export function navAppHref(app: NavApp, links: NavigationLinks): string {
  switch (app) {
    case "google":
      return links.googleMaps;
    case "waze":
      return links.waze;
    case "apple":
      return links.appleMaps;
    case "geo":
      return links.geo;
  }
}
